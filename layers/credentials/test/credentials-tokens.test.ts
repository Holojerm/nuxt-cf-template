// Mailed tokens and the sign-up they carry, against real D1: single use under a
// race, expiry, the per-mailbox mail budget, and the nightly sweep.

import { beforeEach, describe, expect, it } from 'vitest'

import { purgeCredentialTokens } from '../server/utils/credentials-extensions'
import { CREDENTIALS_MAIL_BUDGET } from '../server/utils/credentials-limits'
import { hashNewPassword, passwordUpsert } from '../server/utils/credentials-password'
import { storePasskeyChallenge } from '../server/utils/credentials-passkeys'
import { redeemSignUp, startSignUp } from '../server/utils/credentials-signup'
import {
  consumeCredentialToken,
  CREDENTIAL_TOKEN_TTL_SECONDS,
  mintCredentialToken,
} from '../server/utils/credentials-tokens'
import { addUser, db, fakeHasher, KDF, proofOf, resetCredentialTables } from './lib/fixtures'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const MINUTE = 60_000

beforeEach(resetCredentialTables)

describe('tokens', () => {
  it('stores a hash, not the token', async () => {
    const { token, record } = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'Ada@Example.com',
      now: NOW,
    })
    expect(record.tokenHash).not.toContain(token)
    expect(record.email).toBe('ada@example.com')
  })

  it('is spent by exactly one of two requests that race', async () => {
    const { token } = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'a@example.com',
      now: NOW,
    })
    const results = await Promise.all([
      consumeCredentialToken(db, 'reset', token, NOW + 1000),
      consumeCredentialToken(db, 'reset', token, NOW + 1000),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: 'used' })
  })

  it('refuses an expired token, an unknown one, and one minted for the other purpose', async () => {
    const { token } = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'a@example.com',
      now: NOW,
    })
    const late = NOW + CREDENTIAL_TOKEN_TTL_SECONDS.reset * 1000 + 1
    expect(await consumeCredentialToken(db, 'verify', token, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(await consumeCredentialToken(db, 'reset', 'x'.repeat(43), NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(await consumeCredentialToken(db, 'reset', token, late)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })
})

describe('the per-mailbox mail budget', () => {
  it('stops mailing an address after its budget, and recovers when the window passes', async () => {
    const mint = (now: number) =>
      mintCredentialToken(db, { purpose: 'reset', email: 'a@example.com', now })
    for (let i = 0; i < CREDENTIALS_MAIL_BUDGET.limit; i++) {
      expect((await mint(NOW + i)).withinBudget).toBe(true)
    }
    expect((await mint(NOW + 10)).withinBudget).toBe(false)
    const later = NOW + CREDENTIALS_MAIL_BUDGET.windowSeconds * 1000 + MINUTE
    expect((await mint(later)).withinBudget).toBe(true)
  })

  it('lets exactly the budget through when requests arrive together', async () => {
    const results = await Promise.all(
      Array.from({ length: CREDENTIALS_MAIL_BUDGET.limit + 4 }, () =>
        mintCredentialToken(db, { purpose: 'verify', email: 'a@example.com', now: NOW }),
      ),
    )
    expect(results.filter((result) => result.withinBudget)).toHaveLength(
      CREDENTIALS_MAIL_BUDGET.limit,
    )
  })

  it('counts aliases of one mailbox together, across both kinds of mail', async () => {
    const addresses = [
      'ada@gmail.com',
      'a.d.a@gmail.com',
      'ada+1@gmail.com',
      'ada+2@googlemail.com',
      'ADA@gmail.com',
    ]
    for (const [i, email] of addresses.entries()) {
      await mintCredentialToken(db, { purpose: i % 2 ? 'verify' : 'reset', email, now: NOW })
    }
    const sixth = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'ada+3@gmail.com',
      now: NOW,
    })
    const other = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'grace@gmail.com',
      now: NOW,
    })
    expect(sixth.withinBudget).toBe(false)
    expect(other.withinBudget).toBe(true)
  })
})

describe('sign-up', () => {
  const attribution = { source: 'newsletter', medium: 'email', campaign: null, referrer: null }
  const password = () => hashNewPassword(fakeHasher(), { ...KDF, proof: proofOf('p') })

  it('creates nothing, and holds no password, until the token comes back', async () => {
    const { token, record } = await startSignUp(db, { email: 'Ada@Example.com', attribution }, NOW)
    expect(await db.query.users.findMany()).toEqual([])
    expect(await db.query.credentialPasswords.findMany()).toEqual([])
    expect(JSON.stringify(record.payload)).not.toMatch(/proof|salt|password/i)

    const redeemed = await redeemSignUp(db, token, NOW + MINUTE)
    expect(redeemed).toMatchObject({
      ok: true,
      pending: { email: 'ada@example.com', attribution: { source: 'newsletter' } },
    })
    expect(await redeemSignUp(db, token, NOW + MINUTE)).toEqual({ ok: false, reason: 'used' })
  })

  it('mints the same way for an address that already has a password, and refuses at redemption', async () => {
    await addUser('u1', 'ada@example.com')
    await passwordUpsert(db, 'u1', await password())

    const minted = await startSignUp(db, { email: 'ada@example.com', attribution: null }, NOW)
    expect(minted.withinBudget).toBe(true)
    expect(await redeemSignUp(db, minted.token, NOW + MINUTE)).toEqual({
      ok: false,
      reason: 'already_registered',
    })
  })

  it('lets an account that has no password yet gain one', async () => {
    await addUser('u1', 'ada@example.com')
    const { token } = await startSignUp(db, { email: 'ada@example.com', attribution: null }, NOW)
    expect((await redeemSignUp(db, token, NOW + MINUTE)).ok).toBe(true)
  })

  it('refuses a verification token whose time has passed, or one minted for a reset', async () => {
    const { token } = await startSignUp(db, { email: 'ada@example.com', attribution: null }, NOW)
    const late = NOW + CREDENTIAL_TOKEN_TTL_SECONDS.verify * 1000 + 1
    expect(await redeemSignUp(db, token, late)).toEqual({ ok: false, reason: 'expired' })

    const reset = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'b@example.com',
      now: NOW,
    })
    expect(await redeemSignUp(db, reset.token, NOW)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('the nightly sweep', () => {
  it('removes spent and expired tokens past the grace window and expired challenges, and keeps live ones', async () => {
    const DAY = 24 * 60 * MINUTE
    const old = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'old@example.com',
      now: NOW - 3 * DAY,
    })
    const spent = await mintCredentialToken(db, {
      purpose: 'reset',
      email: 'spent@example.com',
      now: NOW - 2 * DAY,
    })
    await consumeCredentialToken(db, 'reset', spent.token, NOW - 2 * DAY + MINUTE)
    const live = await mintCredentialToken(db, {
      purpose: 'verify',
      email: 'live@example.com',
      now: NOW,
    })
    await storePasskeyChallenge(db, 'stale', 'c1', NOW - DAY)
    await storePasskeyChallenge(db, 'fresh', 'c2', NOW)

    expect(await purgeCredentialTokens(db, { now: NOW })).toEqual({ count: 3, truncated: false })
    const tokens = await db.query.credentialTokens.findMany()
    expect(tokens.map((token) => token.id)).toEqual([live.record.id])
    expect(tokens.some((token) => token.id === old.record.id)).toBe(false)
    expect((await db.query.credentialChallenges.findMany()).map((row) => row.attemptId)).toEqual([
      'fresh',
    ])
  })
})
