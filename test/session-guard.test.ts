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
import { checkSession, isSessionClearOnlyPath } from '../server/utils/session-guard'

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
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: true, role: 'user' })
  })

  it('hands back the role, so requireAdmin does not read the same row again', async () => {
    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, USER))
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: true, role: 'admin' })
  })

  it('accepts a session with no issued-at while nothing has been revoked', async () => {
    // Sessions sealed before this feature shipped have no `issuedAt`. Rejecting
    // them wholesale would log out every existing user on deploy, which is a
    // worse outcome than the narrow risk it would close.
    expect(await checkSession(db, { userId: USER })).toEqual({ valid: true, role: 'user' })
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
    expect(await checkSession(db, fresh)).toEqual({ valid: true, role: 'user' })
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
    expect(await checkSession(db, OLD_SESSION)).toEqual({ valid: true, role: 'user' })

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

// ── Which paths a dead cookie may still pass through ────────────────────────
// The blocker this list exists to prevent: the guard threw on EVERY /api/
// path, including the sign-in surface — and the one cookie guaranteed to be
// present when somebody is trying to sign in again is the stale one. /login's
// SSR fetch of the provider list 401d, so the page said "No sign-in method is
// configured" forever; a valid magic link read as unrecognised; an OAuth
// callback returned raw JSON. A dead cookie locked people out of the recovery
// path itself.

describe('isSessionClearOnlyPath', () => {
  it('lets the whole sign-in surface through', () => {
    // Every one of these is how somebody holding a dead cookie gets a live one.
    for (const path of [
      '/api/auth/providers',
      '/api/auth/magic-link',
      '/api/auth/magic-link/verify',
      '/api/auth/apple',
      '/api/auth/google',
      '/api/auth/logout',
    ]) {
      expect(isSessionClearOnlyPath(path, 'GET'), path).toBe(true)
      expect(isSessionClearOnlyPath(path, 'POST'), path).toBe(true)
    }
  })

  it('lets the liveness probe through', () => {
    // A health check that depends on a cookie is not a health check.
    expect(isSessionClearOnlyPath('/api/health', 'GET')).toBe(true)
  })

  it('lets sign-out through, but not the session read', () => {
    // Signing out authorizes nothing — it destroys a credential — and
    // useUserSession().clear() does not catch a rejection. The GET must fail,
    // because fetch() DOES catch and nulls the session, which is what makes the
    // other browser flip to signed-out.
    expect(isSessionClearOnlyPath('/api/_auth/session', 'DELETE')).toBe(true)
    expect(isSessionClearOnlyPath('/api/_auth/session', 'GET')).toBe(false)
  })

  it('still aborts everything that acts on the account', () => {
    for (const path of [
      '/api/billing/entitlement',
      '/api/account/export',
      '/api/account',
      '/api/admin/users',
      '/api/feedback',
      '/api/mcp/connect-code',
    ]) {
      expect(isSessionClearOnlyPath(path, 'GET'), path).toBe(false)
    }
  })

  it('is not fooled by a path that merely starts like the auth surface', () => {
    // `/api/authorize-something` is not `/api/auth/…`; the trailing slash in
    // the prefix is what keeps a future route from inheriting the exemption.
    expect(isSessionClearOnlyPath('/api/authz/grant', 'POST')).toBe(false)
    expect(isSessionClearOnlyPath('/api/authorized', 'GET')).toBe(false)
  })
})
