// The Turnstile decision: when a challenge is required, when it is skipped,
// and what a rejected one looks like.
//
// decideTurnstile takes its verifier as an argument so this suite can drive
// every branch without a network call and without a Cloudflare account — the
// same reason server/utils/feedback.ts takes its Drizzle client as one.
//
// What is deliberately NOT tested here: the HTTP shape of siteverify. That
// belongs to @nuxtjs/turnstile, and re-asserting it would only pin this repo to
// that module's current internals.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { createMagicLinkToken } from '../server/utils/magic-link'
import {
  decideTurnstile,
  turnstileTokenSchema,
  type TurnstileVerifier,
} from '../server/utils/turnstile'

// The route's own text, so the ordering assertion below cannot drift away from
// the file it describes. Vite resolves `?raw` at transform time, which is what
// makes this readable from inside workerd, where there is no filesystem.
import MINT_ROUTE_SOURCE from '../server/api/auth/magic-link.post.ts?raw'

const SECRET = '0x4AAAAAAA-not-a-real-secret'
const TOKEN = '0.solved-challenge-token'

const passes: TurnstileVerifier = async () => ({ success: true })
const fails: TurnstileVerifier = async () => ({
  success: false,
  'error-codes': ['invalid-input-response'],
})

describe('decideTurnstile', () => {
  it('skips the check entirely when no secret key is configured', async () => {
    // The template ships this way, exactly like an unset Resend key. A fresh
    // clone has to be able to submit the feedback form.
    const verify = vi.fn(passes)

    const decision = await decideTurnstile({ secretKey: '', token: null, verify })

    expect(decision).toEqual({ ok: true, checked: false })
    expect(verify, 'siteverify was called with no secret to send').not.toHaveBeenCalled()
  })

  it('warns when the site key is set but the secret is not', async () => {
    // The one misconfiguration that must not pass quietly: the widget renders,
    // a human solves it, and nothing checks the answer. It still returns ok —
    // failing closed here would break the form for a fork mid-setup — but it
    // says so where a log aggregator can find it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const decision = await decideTurnstile({
      secretKey: undefined,
      siteKey: '1x00000000000000000000AA',
      token: TOKEN,
      verify: passes,
    })

    expect(decision).toEqual({ ok: true, checked: false })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('turnstile_half_configured')
    warn.mockRestore()
  })

  it('stays quiet when neither key is set', async () => {
    // An unconfigured template is not a misconfiguration, and warning on every
    // anonymous submission would train people to filter the channel that
    // carries the previous test's message.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await decideTurnstile({ secretKey: '', siteKey: '', token: null, verify: passes })

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('passes a solved challenge through, forwarding the token verbatim', async () => {
    const verify = vi.fn(passes)

    const decision = await decideTurnstile({ secretKey: SECRET, token: TOKEN, verify })

    expect(decision).toEqual({ ok: true, checked: true })
    expect(verify).toHaveBeenCalledWith(TOKEN, undefined)
  })

  it('rejects a missing token before spending a network round-trip', async () => {
    const verify = vi.fn(passes)

    for (const token of [undefined, null, '', 42, {}]) {
      const decision = await decideTurnstile({ secretKey: SECRET, token, verify })
      expect(decision, `token ${JSON.stringify(token)} should not be accepted`).toEqual({
        ok: false,
        code: 'turnstile_missing',
        errorCodes: ['missing-input-response'],
      })
    }

    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects an oversized token rather than forwarding it', async () => {
    // Cloudflare caps the token at 2048 characters, so anything longer is not a
    // token — it is an unbounded string a stranger chose, on a public endpoint.
    const decision = await decideTurnstile({
      secretKey: SECRET,
      token: 'x'.repeat(2049),
      verify: passes,
    })

    expect(decision).toMatchObject({ ok: false, code: 'turnstile_missing' })
    expect(turnstileTokenSchema.safeParse('x'.repeat(2048)).success).toBe(true)
  })

  it('reports Cloudflare’s error codes when the challenge fails', async () => {
    // Surfaced so the 400 can be diagnosed from logs: `timeout-or-duplicate`
    // (a slow form fill, or a replayed token) reads very differently from
    // `invalid-input-secret` (someone pasted the wrong key).
    const decision = await decideTurnstile({ secretKey: SECRET, token: TOKEN, verify: fails })

    expect(decision).toEqual({
      ok: false,
      code: 'turnstile_failed',
      errorCodes: ['invalid-input-response'],
    })
  })

  it('lets a verifier error propagate instead of failing open', async () => {
    // The opposite of the rate limiters, on purpose. They fail open because
    // they are advisory; a bot check that failed open would hand an attacker a
    // bypass they can trigger on demand by making siteverify slow.
    const exploding: TurnstileVerifier = async () => {
      throw new Error('siteverify unreachable')
    }

    await expect(
      decideTurnstile({ secretKey: SECRET, token: TOKEN, verify: exploding }),
    ).rejects.toThrow('siteverify unreachable')
  })
})

// ── The mint path ───────────────────────────────────────────────────────────
// POST /api/auth/magic-link is the reason this module exists. It sends mail
// from a domain the recipient trusts to an inbox the caller names, and it is
// reachable by anyone.

const db = drizzle(env.DB, { schema })

async function mintedRowCount(): Promise<number> {
  return (await db.select().from(schema.magicLinkTokens)).length
}

/**
 * The route's guard chain, in the route's order.
 *
 * A local composition rather than the handler itself: the handler is an H3
 * event handler that reaches for Nitro auto-imports (`db`, `useRuntimeConfig`,
 * `getCookie`) that do not exist in this pool. What keeps this honest is the
 * source assertion in the describe below — it fails if the route ever stops
 * running the challenge first, which is the only way this composition could
 * quietly stop describing it.
 */
async function mintUnderGuard(input: {
  secretKey: string | undefined
  token: unknown
  verify: TurnstileVerifier
  email: string
}): Promise<{ minted: boolean }> {
  const decision = await decideTurnstile({
    secretKey: input.secretKey,
    token: input.token,
    verify: input.verify,
  })
  if (!decision.ok) return { minted: false }

  await createMagicLinkToken(db, { email: input.email })
  return { minted: true }
}

describe('the magic-link mint path', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM magic_link_tokens')
  })

  // Two narrowings before anything is searched for, and both were earned by a
  // false result rather than anticipated:
  //
  //   * Start at the handler, because everything above it is the import block,
  //     where `normalizeEmail` and friends appear as names rather than calls.
  //   * Drop whole-line comments, because this route is heavily commented and
  //     those comments discuss the very calls being located — the first version
  //     of the assertion below matched the sentence explaining the rule instead
  //     of the code obeying it, and reported the rule broken while it held.
  //
  // Only whole-line comments: a trailing `//` cannot be stripped safely without
  // parsing string literals, and there is nothing to gain by trying.
  const handlerBody = MINT_ROUTE_SOURCE.slice(MINT_ROUTE_SOURCE.indexOf('defineEventHandler('))
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

  it('runs the challenge before it charges the per-address budget', () => {
    // The ordering IS the security property, and it is invisible in a diff that
    // moves three lines down. That budget is keyed by somebody else's mailbox:
    // a script that can spend it without solving a challenge locks a named
    // victim out of their own sign-in, five requests at a time, without sending
    // a single email. Put the challenge second and the rate limit becomes the
    // attack it was added to prevent.
    const challenge = handlerBody.indexOf('await requireTurnstile(')
    const budget = handlerBody.indexOf('await addressBudgetExhausted(')

    expect(challenge, 'the mint route no longer calls requireTurnstile').toBeGreaterThan(-1)
    expect(budget, 'the mint route no longer charges a per-address budget').toBeGreaterThan(-1)
    expect(challenge, 'requireTurnstile must come first — see the comment above it').toBeLessThan(
      budget,
    )
  })

  it('does no address-dependent work before the challenge', () => {
    // Weaker than the budget rule and worth pinning anyway: nothing should
    // branch on who the caller named until the caller is established as a
    // browser. It also keeps the 400 identical for every address, which is what
    // stops the bot check itself becoming an enumeration oracle.
    const challenge = handlerBody.indexOf('await requireTurnstile(')
    const firstAddressUse = handlerBody.indexOf('normalizeEmail(')

    expect(firstAddressUse).toBeGreaterThan(-1)
    expect(challenge).toBeLessThan(firstAddressUse)
  })

  it('mints nothing when the challenge token is missing', async () => {
    const result = await mintUnderGuard({
      secretKey: SECRET,
      token: null,
      verify: passes,
      email: 'ada@example.com',
    })

    expect(result.minted).toBe(false)
    // The row is the thing that matters: a minted token is a live credential
    // sitting in the database whether or not the email ever left.
    expect(await mintedRowCount()).toBe(0)
  })

  it('mints nothing when the challenge fails', async () => {
    const result = await mintUnderGuard({
      secretKey: SECRET,
      token: TOKEN,
      verify: fails,
      email: 'ada@example.com',
    })

    expect(result.minted).toBe(false)
    expect(await mintedRowCount()).toBe(0)
  })

  it('mints normally when Turnstile is not configured', async () => {
    // The property that lets a fresh clone sign in. If this ever fails, the
    // template has acquired a mandatory third-party account.
    const verify = vi.fn(passes)

    const result = await mintUnderGuard({
      secretKey: '',
      token: null,
      verify,
      email: 'ada@example.com',
    })

    expect(result.minted).toBe(true)
    expect(await mintedRowCount()).toBe(1)
    expect(verify).not.toHaveBeenCalled()
  })

  it('mints once the challenge is solved', async () => {
    const result = await mintUnderGuard({
      secretKey: SECRET,
      token: TOKEN,
      verify: passes,
      email: 'ada@example.com',
    })

    expect(result.minted).toBe(true)
    expect(await mintedRowCount()).toBe(1)
  })
})
