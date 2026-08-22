// Account provisioning, against a real D1 inside workerd.
//
// The cases that matter aren't "does an insert work" — they're the ones that
// decide whether two sign-ins are the same person: casing, a second provider on
// the same address, and a profile that changed since last time.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { generateReferralCode, normalizeEmail, upsertOAuthUser } from '../server/utils/users'

const db = drizzle(env.DB, { schema })

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
})

describe('normalizeEmail', () => {
  it('lowercases and trims, because the unique index does neither', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })
})

describe('upsertOAuthUser', () => {
  it('creates an account on first sign-in', async () => {
    const { user, created } = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://example.com/a.png',
    })

    expect(created).toBe(true)
    expect(user.email).toBe('ada@example.com')
    expect(user.name).toBe('Ada Lovelace')
    expect(user.provider).toBe('github')
    expect(user.role).toBe('user')
    expect(user.lastLoginAt).toBeInstanceOf(Date)
  })

  it('returns the same account on a second sign-in', async () => {
    const first = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
    })
    const second = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
    })

    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)

    const rows = await db.select().from(schema.users)
    expect(rows).toHaveLength(1)
  })

  it('treats a different-cased address as the same account', async () => {
    const first = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    const second = await upsertOAuthUser(db, { provider: 'github', email: 'ADA@Example.com' })

    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
  })

  it('links a second provider to the existing account, not a duplicate', async () => {
    // The whole point of keying on email: sign in with GitHub today, Google
    // tomorrow, keep the same subscription.
    const github = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    const google = await upsertOAuthUser(db, { provider: 'google', email: 'ada@example.com' })

    expect(google.user.id).toBe(github.user.id)
    // `provider` records who created the account and is not rewritten — it's
    // support context ("which button did I press the first time?"), not state.
    expect(google.user.provider).toBe('github')
  })

  it('refreshes name and avatar from the provider', async () => {
    await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: 'https://example.com/old.png',
    })
    const { user } = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://example.com/new.png',
    })

    expect(user.name).toBe('Ada Lovelace')
    expect(user.avatarUrl).toBe('https://example.com/new.png')
  })

  it('keeps the old avatar when the provider sends none', async () => {
    await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      avatarUrl: 'https://example.com/a.png',
    })
    const { user } = await upsertOAuthUser(db, { provider: 'google', email: 'ada@example.com' })

    expect(user.avatarUrl).toBe('https://example.com/a.png')
  })

  it('never lets a provider set the role', async () => {
    // An identity provider proves who you are, not what you're allowed to do.
    // Promote someone in the DB and a later sign-in must not demote them.
    const { user } = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id))

    const again = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    expect(again.user.role).toBe('admin')
  })

  it('falls back to the local-part when a provider sends no name', async () => {
    // GitHub returns name: null for anyone who never filled in their profile.
    const { user } = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    expect(user.name).toBe('ada')
  })
})

// ── Referral codes ──────────────────────────────────────────────────────────
// A code that is shared is a code that gets mistyped, so the properties worth
// pinning are the transcription ones — and that provisioning mints one at all,
// since a later wave will assume every new account has one.

describe('generateReferralCode', () => {
  it('avoids the characters people confuse when reading a code aloud', () => {
    // 0/O and 1/I/L are the whole reason the alphabet isn't base36.
    for (let i = 0; i < 200; i++) {
      expect(generateReferralCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
    }
  })

  it('does not repeat itself', () => {
    // Not a randomness proof — a canary for the generator collapsing to a
    // constant, which is what a broken rejection loop looks like.
    const codes = new Set(Array.from({ length: 500 }, () => generateReferralCode()))
    expect(codes.size).toBe(500)
  })
})

describe('upsertOAuthUser referral codes', () => {
  it('mints one on the account it creates', async () => {
    const { user } = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    expect(user.referralCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
    // Redemption is a later wave's job; nothing sets this yet.
    expect(user.referredBy).toBeNull()
  })

  it('gives two accounts different codes, and never re-mints on sign-in', async () => {
    const first = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    const second = await upsertOAuthUser(db, { provider: 'github', email: 'grace@example.com' })
    expect(first.user.referralCode).not.toBe(second.user.referralCode)

    // A code someone has already shared must survive them signing in again.
    const again = await upsertOAuthUser(db, { provider: 'google', email: 'ada@example.com' })
    expect(again.user.referralCode).toBe(first.user.referralCode)
  })
})

// ── First-touch attribution ─────────────────────────────────────────────────
// The rule worth a test is the one that is invisible when broken: attribution
// must be written once and never again, or every customer eventually looks like
// they arrived via a branded search.

describe('upsertOAuthUser attribution', () => {
  const PROFILE = { provider: 'github', email: 'ada@example.com', name: 'Ada Lovelace' }

  it('records the channel on the account it creates', async () => {
    const { user } = await upsertOAuthUser(db, PROFILE, {
      source: 'newsletter',
      medium: 'email',
      campaign: 'launch',
      referrer: 'https://news.example.com/post',
    })

    expect(user.signupSource).toBe('newsletter')
    expect(user.signupMedium).toBe('email')
    expect(user.signupCampaign).toBe('launch')
    expect(user.signupReferrer).toBe('https://news.example.com/post')
  })

  it('never overwrites it on a later sign-in', async () => {
    await upsertOAuthUser(db, PROFILE, { source: 'newsletter', medium: 'email' })

    // Same person comes back weeks later, this time via a branded search.
    const { user, created } = await upsertOAuthUser(db, PROFILE, {
      source: 'google.com',
      medium: 'organic',
    })

    expect(created).toBe(false)
    expect(user.signupSource).toBe('newsletter')
    expect(user.signupMedium).toBe('email')
  })

  it('creates the account fine when there is no attribution at all', async () => {
    const { user, created } = await upsertOAuthUser(db, PROFILE, null)
    expect(created).toBe(true)
    expect(user.signupSource).toBeNull()
  })
})

describe('referral code collisions', () => {
  // The retry in upsertOAuthUser is the kind of code that is written once,
  // never executed, and quietly wrong. A genuine collision is a 1-in-6.6e11
  // event, so nothing would ever have run this branch — and the branch turns on
  // isReferralCodeCollision() matching an error STRING that D1 produces. That
  // match cannot be verified by reading it; it has to meet the real driver.
  //
  // The `mintCode` seam exists for exactly this and nothing else.

  it('retries onto a fresh code and still creates the account', async () => {
    const taken = 'TAKEN123'
    await db
      .insert(schema.users)
      .values({ id: 'holder', email: 'holder@example.com', name: 'holder', referralCode: taken })

    // First mint collides with the row above; the second must be allowed
    // through. If the retry did not exist, or the error string stopped
    // matching, this rejects instead.
    const codes = [taken, 'FRESH456']
    let calls = 0
    const mintCode = () => codes[calls++] ?? generateReferralCode()

    const { user, created } = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'ada@example.com' },
      null,
      { mintCode },
    )

    expect(calls).toBe(2)
    expect(created).toBe(true)
    expect(user.referralCode).toBe('FRESH456')
  })

  it('gives up rather than looping forever when every code collides', async () => {
    const taken = 'ALWAYS12'
    await db
      .insert(schema.users)
      .values({ id: 'holder', email: 'holder@example.com', name: 'holder', referralCode: taken })

    let calls = 0
    const mintCode = () => {
      calls++
      return taken
    }

    // Bounded on purpose: an unbounded retry turns a broken generator into a
    // hung sign-in, and five collisions means the randomness is broken and
    // deserves to be thrown rather than papered over.
    let caught: unknown
    try {
      await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' }, null, { mintCode })
    } catch (error) {
      caught = error
    }

    expect(calls).toBe(5)
    // Asserted on the CAUSE, not the message. Drizzle wraps D1's error, so the
    // constraint text is one level down — the exact detail that made
    // isReferralCodeCollision silently match nothing.
    const cause = (caught as Error | undefined)?.cause as Error | undefined
    expect(cause?.message).toMatch(/UNIQUE constraint failed: users\.referral_code/)
  })

})
