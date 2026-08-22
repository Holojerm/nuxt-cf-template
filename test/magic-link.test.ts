// Magic-link sign-in, against a real D1 inside workerd.
//
// The interesting cases are not "does an insert work". They are the three ways
// a link is supposed to stop working — spent, expired, never existed — plus the
// race between two requests carrying the same token, which is the one that
// turns a login into a login bypass if the check and the write ever come apart.
// That race cannot be reproduced against a fake: it needs the real driver's
// UPDATE … WHERE … RETURNING semantics.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { isMandatoryNotification } from '#shared/utils/notifications'
import * as schema from '../server/db/schema'
import { safeRedirectPath } from '../server/utils/auth'
import { MAGIC_LINK_EVENT_TYPE, magicLinkEmail } from '../server/utils/auth-email-templates'
import { buildResendEmailRequest } from '../server/utils/email'
import {
  attributionFromRecord,
  consumeMagicLinkToken,
  createMagicLinkToken,
  discardMagicLinkToken,
  generateMagicLinkToken,
  hashMagicLinkToken,
  inspectMagicLinkToken,
  MAGIC_LINK_RATE_LIMIT,
  MAGIC_LINK_TOKEN_PATTERN,
  MAGIC_LINK_TTL_SECONDS,
} from '../server/utils/magic-link'
import { consumeRateLimit, type RateLimitStore } from '../server/utils/rate-limit'

const db = drizzle(env.DB, { schema })

beforeEach(async () => {
  await env.DB.exec('DELETE FROM magic_link_tokens')
})

// ── The token itself ────────────────────────────────────────────────────────
// Its only defence is being unguessable and never being stored in the clear, so
// those are the two properties worth pinning.

describe('generateMagicLinkToken', () => {
  it('is URL-safe, so a mail client cannot mangle it', () => {
    // base64url, unpadded: no +, no /, no = to be percent-encoded, re-encoded by
    // a gateway rewriter, and then no longer match the hash we stored.
    for (let i = 0; i < 200; i++) {
      expect(generateMagicLinkToken()).toMatch(MAGIC_LINK_TOKEN_PATTERN)
    }
  })

  it('spends its whole entropy budget', () => {
    // 32 random bytes → 43 base64url characters. A shorter token here would mean
    // the generator quietly lost bytes somewhere.
    expect(generateMagicLinkToken()).toHaveLength(43)
  })

  it('does not repeat itself', () => {
    // Not a randomness proof — a canary for the generator collapsing, which is
    // what a broken CSPRNG call looks like from the outside.
    const tokens = new Set(Array.from({ length: 500 }, () => generateMagicLinkToken()))
    expect(tokens.size).toBe(500)
  })
})

describe('hashMagicLinkToken', () => {
  it('is a stable SHA-256 hex digest', async () => {
    const digest = await hashMagicLinkToken('a-token')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashMagicLinkToken('a-token')).toBe(digest)
  })

  it('separates tokens that differ by one character', async () => {
    expect(await hashMagicLinkToken('token-a')).not.toBe(await hashMagicLinkToken('token-b'))
  })

  it('never stores the token itself', async () => {
    const { token, record } = await createMagicLinkToken(db, { email: 'ada@example.com' })

    expect(record.tokenHash).toBe(await hashMagicLinkToken(token))
    // The row must contain nothing an attacker with a database dump could use.
    expect(JSON.stringify(record)).not.toContain(token)
  })
})

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('createMagicLinkToken', () => {
  it('normalizes the address the row is keyed by', async () => {
    // Must match `users.email`, which is lowercased — otherwise a link minted
    // for "Ada@Example.com" redeems into a second account.
    const { record } = await createMagicLinkToken(db, { email: '  Ada@Example.COM ' })
    expect(record.email).toBe('ada@example.com')
  })

  it('expires the link a quarter of an hour out', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    const { record } = await createMagicLinkToken(db, { email: 'ada@example.com' }, now)

    expect(record.expiresAt.getTime()).toBe(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000)
    expect(record.usedAt).toBeNull()
  })

  it('leaves earlier links for the same address working', async () => {
    // Deliberate: people click the first mail they find, and invalidating on
    // reissue is the most common way a working link reports itself as broken.
    const first = await createMagicLinkToken(db, { email: 'ada@example.com' })
    await createMagicLinkToken(db, { email: 'ada@example.com' })

    expect((await inspectMagicLinkToken(db, first.token)).ok).toBe(true)
  })

  it('sweeps this address’s expired rows when it mints the next one', async () => {
    const long = new Date('2026-01-01T12:00:00Z')
    await createMagicLinkToken(db, { email: 'ada@example.com' }, long)
    await createMagicLinkToken(db, { email: 'grace@example.com' }, long)

    // An hour later, well past the 15-minute TTL of both rows above.
    await createMagicLinkToken(db, { email: 'ada@example.com' }, new Date('2026-01-01T13:00:00Z'))

    const rows = await db.select().from(schema.magicLinkTokens)
    const emails = rows.map((row) => row.email).sort()
    // Ada's stale row is gone; Grace's is untouched, because the sweep is
    // scoped to the address that asked and is never a full-table scan.
    expect(emails).toEqual(['ada@example.com', 'grace@example.com'])
    expect(rows.filter((row) => row.email === 'ada@example.com')).toHaveLength(1)
  })
})

describe('consumeMagicLinkToken', () => {
  it('works exactly once', async () => {
    const { token } = await createMagicLinkToken(db, { email: 'ada@example.com' })

    const first = await consumeMagicLinkToken(db, token)
    expect(first).toMatchObject({ ok: true })

    // The replay every forwarded email, browser back button, and prefetching
    // mail scanner will eventually produce.
    const second = await consumeMagicLinkToken(db, token)
    expect(second).toEqual({ ok: false, reason: 'used' })
  })

  it('stamps used_at rather than deleting the row', async () => {
    // The row has to survive redemption, or a replay looks like a token that
    // never existed and the page says the wrong thing about it.
    const now = new Date('2026-01-01T12:05:00Z')
    const { token, record } = await createMagicLinkToken(
      db,
      { email: 'ada@example.com' },
      new Date('2026-01-01T12:00:00Z'),
    )

    await consumeMagicLinkToken(db, token, now)

    const stored = await db.query.magicLinkTokens.findFirst({
      where: eq(schema.magicLinkTokens.id, record.id),
    })
    expect(stored?.usedAt?.getTime()).toBe(now.getTime())
  })

  it('refuses a link that has aged out', async () => {
    const minted = new Date('2026-01-01T12:00:00Z')
    const { token } = await createMagicLinkToken(db, { email: 'ada@example.com' }, minted)

    // One second past the window.
    const late = new Date(minted.getTime() + (MAGIC_LINK_TTL_SECONDS + 1) * 1000)
    expect(await consumeMagicLinkToken(db, token, late)).toEqual({ ok: false, reason: 'expired' })

    // And the row is still unused, so nothing was half-spent on the way out.
    const rows = await db.select().from(schema.magicLinkTokens)
    expect(rows[0]?.usedAt).toBeNull()
  })

  it('still works on the last second of the window', async () => {
    const minted = new Date('2026-01-01T12:00:00Z')
    const { token } = await createMagicLinkToken(db, { email: 'ada@example.com' }, minted)

    const justInTime = new Date(minted.getTime() + (MAGIC_LINK_TTL_SECONDS - 1) * 1000)
    expect((await consumeMagicLinkToken(db, token, justInTime)).ok).toBe(true)
  })

  it('refuses a token nobody ever minted', async () => {
    expect(await consumeMagicLinkToken(db, generateMagicLinkToken())).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('lets exactly one of two concurrent redemptions win', async () => {
    // The reason the check and the write are a single UPDATE. Read-then-write
    // would let both of these observe `used_at IS NULL`, both proceed, and both
    // be handed a session — a login bypass that only shows up under a double
    // click or a link opened twice.
    const { token } = await createMagicLinkToken(db, { email: 'ada@example.com' })

    const results = await Promise.all([
      consumeMagicLinkToken(db, token),
      consumeMagicLinkToken(db, token),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toHaveLength(1)
  })
})

describe('inspectMagicLinkToken', () => {
  it('answers without spending the token', async () => {
    // The whole point of the GET/POST split: a mail scanner that follows the
    // link must leave it usable for the person it was sent to.
    const { token } = await createMagicLinkToken(db, { email: 'ada@example.com' })

    const looked = await inspectMagicLinkToken(db, token)
    expect(looked).toMatchObject({ ok: true })

    const rows = await db.select().from(schema.magicLinkTokens)
    expect(rows[0]?.usedAt).toBeNull()
    expect((await consumeMagicLinkToken(db, token)).ok).toBe(true)
  })

  it('reports the same three failures the redeeming path does', async () => {
    const minted = new Date('2026-01-01T12:00:00Z')
    const spent = await createMagicLinkToken(db, { email: 'ada@example.com' }, minted)
    await consumeMagicLinkToken(db, spent.token, minted)
    const stale = await createMagicLinkToken(db, { email: 'grace@example.com' }, minted)

    expect(await inspectMagicLinkToken(db, spent.token, minted)).toEqual({
      ok: false,
      reason: 'used',
    })
    expect(await inspectMagicLinkToken(db, stale.token, new Date('2026-01-01T13:00:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(await inspectMagicLinkToken(db, generateMagicLinkToken(), minted)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })
})

describe('discardMagicLinkToken', () => {
  it('removes a link that was never delivered', async () => {
    // Called when Resend refuses the send: nobody holds this token, so a row
    // claiming a live link is out there would be a lie.
    const { token, record } = await createMagicLinkToken(db, { email: 'ada@example.com' })
    await discardMagicLinkToken(db, record.id)

    expect(await inspectMagicLinkToken(db, token)).toEqual({ ok: false, reason: 'invalid' })
  })
})

// ── What the row carries across a device boundary ───────────────────────────
// A magic link routinely finishes on a phone after starting on a laptop, where
// neither the `auth-redirect` nor the `attr` cookie exists. These columns are
// what stop a deep link and a first-touch channel from disappearing on exactly
// the signups a consumer product cares most about.

describe('cross-device carry', () => {
  it('remembers where the person was going', async () => {
    const { record } = await createMagicLinkToken(db, {
      email: 'ada@example.com',
      redirectTo: '/account?tab=billing',
    })
    expect(record.redirectTo).toBe('/account?tab=billing')
  })

  it('stores null rather than an empty string when there was no destination', async () => {
    const { record } = await createMagicLinkToken(db, { email: 'ada@example.com', redirectTo: '' })
    expect(record.redirectTo).toBeNull()
  })

  it('is only ever handed a destination safeRedirectPath already cleared', async () => {
    // The guard lives at the route, not in the table, so this documents the
    // contract the route has to keep: an open redirect stored on a row is an
    // open redirect with a fifteen-minute fuse and a signed-in victim.
    // These are the bypasses test/auth-redirect.test.ts enumerates.
    for (const hostile of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      expect(safeRedirectPath(hostile, '')).toBe('')
    }
    const { record } = await createMagicLinkToken(db, {
      email: 'ada@example.com',
      redirectTo: safeRedirectPath('//evil.example', ''),
    })
    expect(record.redirectTo).toBeNull()
  })

  it('carries first-touch attribution to the device that redeems the link', async () => {
    const { record } = await createMagicLinkToken(db, {
      email: 'ada@example.com',
      attribution: { source: 'newsletter', medium: 'email', campaign: 'launch' },
    })

    expect(attributionFromRecord(record)).toEqual({
      source: 'newsletter',
      medium: 'email',
      campaign: 'launch',
      referrer: undefined,
      referralCode: undefined,
    })
  })

  it('carries the referral code too — the field that is worth money', async () => {
    // The whole point of the column. A lost `signup_source` is a marketing row
    // that reads `direct`; a lost referral code is somebody who was promised
    // days for inviting a friend and silently did not get them.
    const { record } = await createMagicLinkToken(db, {
      email: 'ada@example.com',
      attribution: { source: 'referral', medium: 'invite', referralCode: 'AB2CD3EF' },
    })

    expect(record.referralCode).toBe('AB2CD3EF')
    expect(attributionFromRecord(record)).toMatchObject({ referralCode: 'AB2CD3EF' })
  })

  it('returns undefined, not an empty object, when there is none to carry', async () => {
    // undefined and null mean different things to establishSession: undefined
    // lets it fall back to the redeeming browser's cookie, null suppresses that.
    const { record } = await createMagicLinkToken(db, { email: 'ada@example.com' })
    expect(attributionFromRecord(record)).toBeUndefined()
  })
})

// ── Deleted accounts stay deleted ───────────────────────────────────────────
// Deleting an account anonymizes the `users` row in place and leaves it keyed
// by `deleted-<id>@deleted.invalid` (server/utils/account.ts). Identity is the
// email address, so a link minted for that tombstone would redeem straight into
// the deleted account's id — entitlement history, audit trail, role and all.
// The only thing stopping it in production today is that Resend happens to
// refuse `.invalid`, which is a coincidence rather than a guard.

// The predicate itself is tested in test/users.test.ts, where it lives — it is
// a rule about the identity key, and the session guard reads it too. What
// belongs here is that the mint path actually applies it.

describe('createMagicLinkToken with a reserved address', () => {
  it('refuses rather than minting, even though the route never gets this far', () => {
    // Defence in depth: the route answers such a request with its ordinary
    // success body and never calls this. Reaching it means a second caller was
    // added without the guard, which should be loud.
    return expect(
      createMagicLinkToken(db, { email: 'deleted-abc@deleted.invalid' }),
    ).rejects.toThrow(/reserved address/i)
  })

  it('writes nothing when it refuses', async () => {
    await createMagicLinkToken(db, { email: 'deleted-abc@deleted.invalid' }).catch(() => null)
    expect(await db.select().from(schema.magicLinkTokens)).toHaveLength(0)
  })
})

// ── The sign-in link is security-class mail ─────────────────────────────────

describe('MAGIC_LINK_EVENT_TYPE', () => {
  it('is classified mandatory by its prefix, not by an allowlist entry', () => {
    // The `security.` prefix is what makes every enforcement point in
    // shared/utils/notifications.ts refuse to make this unsubscribable —
    // isNotificationEnabled() short-circuits, buildResendEmailRequest() strips
    // the header. Rename it out of that namespace and this goes red.
    expect(isMandatoryNotification(MAGIC_LINK_EVENT_TYPE)).toBe(true)
  })

  it('produces an email with no unsubscribe affordance of any kind', () => {
    // True today because the send passes no `unsubscribe` option at all. Pinned
    // because "correct because a caller omitted an argument" survives exactly
    // until the next refactor — and an inbox that can one-click-suppress its own
    // sign-in links is an inbox that has locked itself out.
    const email = magicLinkEmail(
      { appName: 'My App', appUrl: 'https://example.com' },
      { url: 'https://example.com/auth/verify?token=abc', expiresMinutes: 15 },
    )
    const request = buildResendEmailRequest({ to: 'ada@example.com', ...email }, 'me@example.com')

    expect(request.headers).toBeUndefined()
    expect(request.text).not.toMatch(/unsubscribe/i)
    expect(request.html).not.toMatch(/unsubscribe/i)
  })
})

// ── The per-address limit ───────────────────────────────────────────────────
// The IP limit in server/middleware/auth.ts does not cover the abuse this
// endpoint enables: it sends mail, from a trusted domain, to an address an
// anonymous caller picked. Without a per-address bucket a botnet spread over
// many IPs is a mail cannon aimed at one inbox.

describe('MAGIC_LINK_RATE_LIMIT', () => {
  function makeStore(): RateLimitStore {
    const data = new Map<string, unknown>()
    return {
      get: async (key) => data.get(key),
      set: async (key, value) => data.set(key, value),
    }
  }

  const now = 1_000_000_000_000

  it('allows a handful of retries and then stops', async () => {
    const store = makeStore()
    const opts = { ...MAGIC_LINK_RATE_LIMIT, key: `${MAGIC_LINK_RATE_LIMIT.name}:ada-hash` }

    for (let i = 0; i < MAGIC_LINK_RATE_LIMIT.limit; i++) {
      expect((await consumeRateLimit(store, opts, now)).allowed).toBe(true)
    }
    expect((await consumeRateLimit(store, opts, now)).allowed).toBe(false)
  })

  it('gives each address its own bucket', async () => {
    // Otherwise one person retrying locks everyone else out of email sign-in —
    // the failure mode that makes people delete the rate limit entirely.
    const store = makeStore()
    const ada = { ...MAGIC_LINK_RATE_LIMIT, key: `${MAGIC_LINK_RATE_LIMIT.name}:ada-hash` }
    const grace = { ...MAGIC_LINK_RATE_LIMIT, key: `${MAGIC_LINK_RATE_LIMIT.name}:grace-hash` }

    for (let i = 0; i < MAGIC_LINK_RATE_LIMIT.limit + 2; i++) {
      await consumeRateLimit(store, ada, now)
    }

    expect((await consumeRateLimit(store, ada, now)).allowed).toBe(false)
    expect((await consumeRateLimit(store, grace, now)).allowed).toBe(true)
  })

  it('recovers within the same order of magnitude as the link TTL', async () => {
    // A window much longer than the link's life strands someone whose first
    // link expired while they were looking for it.
    expect(MAGIC_LINK_RATE_LIMIT.windowSeconds).toBeLessThanOrEqual(MAGIC_LINK_TTL_SECONDS * 2)
  })
})
