// The referral loop's part in account creation: a code per account, `referred_by`
// resolved from the visitor's claim, and the retry on a collision. Drives
// upsertOAuthUser() with the loop's signup contributor against a real D1.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { generateReferralCode } from '../server/utils/referral-codes'
import { createReferralSignup } from '../server/utils/referral-signup'
import { upsertOAuthUser } from '~~/server/utils/users'

const db = drizzle(env.DB, { schema })
const withReferral = (mintCode?: () => string) => ({
  contributors: [createReferralSignup({ mintCode })],
})

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
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
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'ada@example.com' },
      null,
      withReferral(),
    )
    expect(user.referralCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
    // Redemption is a later wave's job; nothing sets this yet.
    expect(user.referredBy).toBeNull()
  })

  it('gives two accounts different codes, and never re-mints on sign-in', async () => {
    const first = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'ada@example.com' },
      null,
      withReferral(),
    )
    const second = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'grace@example.com' },
      null,
      withReferral(),
    )
    expect(first.user.referralCode).not.toBe(second.user.referralCode)

    // A code someone has already shared must survive them signing in again.
    const again = await upsertOAuthUser(
      db,
      { provider: 'google', email: 'ada@example.com' },
      null,
      withReferral(),
    )
    expect(again.user.referralCode).toBe(first.user.referralCode)
  })
})

describe('referral code collisions', () => {
  // The retry in upsertOAuthUser is the kind of code that is written once,
  // never executed, and quietly wrong. A genuine collision is a 1-in-6.6e11
  // event, so nothing would ever have run this branch — and the branch turns on
  // isReferralCodeCollision() matching an error STRING that D1 produces. That
  // match cannot be verified by reading it; it has to meet the real driver.
  //
  // The `mintCode` option of createReferralSignup() exists for exactly this and
  // nothing else.

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
      withReferral(mintCode),
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
      await upsertOAuthUser(
        db,
        { provider: 'github', email: 'ada@example.com' },
        null,
        withReferral(mintCode),
      )
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

describe('the claim a visitor arrives with', () => {
  it('resolves a code that names a live account into `referred_by`', async () => {
    await db.insert(schema.users).values({
      id: 'referrer',
      email: 'referrer@example.com',
      name: 'Referrer',
      referralCode: 'AB2CD3EF',
    })
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'ada@example.com' },
      { referralCode: 'AB2CD3EF' },
      withReferral(),
    )
    expect(user.referredBy).toBe('AB2CD3EF')
  })

  it('drops a code nobody holds, and the sender’s own mailbox', async () => {
    await db.insert(schema.users).values({
      id: 'referrer',
      email: 'ada@example.com',
      name: 'Referrer',
      referralCode: 'AB2CD3EF',
    })
    const unheld = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'grace@example.com' },
      { referralCode: 'ZZZZ2222' },
      withReferral(),
    )
    expect(unheld.user.referredBy).toBeNull()

    const sameMailbox = await upsertOAuthUser(
      db,
      { provider: 'github', email: 'ada+two@example.com' },
      { referralCode: 'AB2CD3EF' },
      withReferral(),
    )
    expect(sameMailbox.user.referredBy).toBeNull()
  })
})
