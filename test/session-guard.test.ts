// Session revocation, against a real D1 inside workerd.
//
// The property under test is the one a sealed-cookie session could not have
// before `users.sessions_invalid_before` existed: that deleting an account on
// one device ends it on every device. Browser A deletes; browser B is still
// holding a perfectly valid, correctly signed cookie for an account with
// retained entitlements. Every one of these cases is that cookie.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { deleteAccount } from '../server/utils/account'
import { checkSession } from '../server/utils/session-guard'

const db = drizzle(env.DB, { schema })

const USER = 'user-1'
/** A session sealed well before anything below happens. */
const OLD_SESSION = {
  userId: USER,
  issuedAt: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000),
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM magic_link_tokens')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db
    .insert(schema.users)
    .values({ id: USER, email: 'ada@example.com', name: 'Ada', referralCode: 'ADA22222' })
})

describe('checkSession', () => {
  it('accepts an ordinary session for an ordinary account', async () => {
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: true })
  })

  it('accepts a session with no issued-at while nothing has been revoked', async () => {
    // Sessions sealed before this feature shipped have no `issuedAt`. Rejecting
    // them wholesale would log out every existing user on deploy, which is a
    // worse outcome than the narrow risk it would close.
    expect(await checkSession(db, { userId: USER })).toEqual({ valid: true })
  })

  it('refuses a session for an account that no longer has a row', async () => {
    await db.delete(schema.users).where(eq(schema.users.id, USER))
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: false, reason: 'no_account' })
  })

  it('refuses every session issued before the revocation instant', async () => {
    await db
      .update(schema.users)
      .set({ sessionsInvalidBefore: new Date('2026-06-01T00:00:00Z') })
      .where(eq(schema.users.id, USER))

    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: false, reason: 'revoked' })
  })

  it('accepts a session issued after it — the point of a watermark, not a flag', async () => {
    // "Sign out everywhere, then sign back in" has to work, or the primitive is
    // just a permanent ban.
    await db
      .update(schema.users)
      .set({ sessionsInvalidBefore: new Date('2026-06-01T00:00:00Z') })
      .where(eq(schema.users.id, USER))

    const fresh = { userId: USER, issuedAt: Math.floor(Date.parse('2026-06-02T00:00:00Z') / 1000) }
    expect(await checkSession(db, fresh)).toEqual({ valid: true })
  })

  it('refuses an undated session once the account HAS a revocation instant', async () => {
    // It cannot prove it postdates the revocation, and on this column "cannot
    // prove" has to mean no — otherwise the one cookie an attacker would most
    // like to hold is the one class the check waves through.
    await db
      .update(schema.users)
      .set({ sessionsInvalidBefore: new Date('2026-06-01T00:00:00Z') })
      .where(eq(schema.users.id, USER))

    expect(await checkSession(db, { userId: USER })).toEqual({ valid: false, reason: 'undated' })
  })

  it('refuses a tombstoned row even with the watermark cleared', async () => {
    // Defence in depth: deletion sets both, and this is the half that holds if
    // some future path forgets the watermark. A tombstone must never authorize.
    await db
      .update(schema.users)
      .set({ email: `deleted-${USER}@deleted.invalid`, sessionsInvalidBefore: null })
      .where(eq(schema.users.id, USER))

    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: false, reason: 'deleted' })
  })
})

describe('deleteAccount ends sessions on every other device', () => {
  it('kills the cookie the other browser is still holding', async () => {
    // The whole finding, in one test. Delete from browser A; browser B's
    // session — valid a moment ago, still correctly signed — is now dead.
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: true })

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    const verdict = await checkSession(db, OLD_SESSION)
    expect(verdict.valid).toBe(false)
  })

  it('records the revocation instant on the row, not just the tombstone', async () => {
    await deleteAccount(db, USER)
    const row = await db.query.users.findFirst({ where: eq(schema.users.id, USER) })
    expect(row?.sessionsInvalidBefore).toBeInstanceOf(Date)
  })
})
