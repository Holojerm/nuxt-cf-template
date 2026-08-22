// What a sealed session contains, exactly.
//
// ── Why this is worth a test ─────────────────────────────────────────────────
// `replaceUserSession` does not replace. Read h3: it calls `session.clear()`,
// which drops the cached session off the request context and queues an outgoing
// clear cookie but leaves the INCOMING Cookie header untouched — and then
// `update()` re-unseals that cookie and shallow-merges the new data over the
// old contents. So the guarantee "signing in as B does not inherit A's data"
// holds only for as long as the payload writes every top-level key.
//
// That is an invariant with a real failure mode on a shared browser, and it is
// invisible: nothing throws, nothing logs, the session just quietly carries a
// field belonging to the previous person. Adding a key to `UserSession` and
// forgetting `buildSessionPayload` is the way it happens, so the key set is
// pinned here rather than remembered.

import { describe, expect, it, vi } from 'vitest'

import { afterSignIn, buildSessionPayload, SESSION_PAYLOAD_KEYS } from '../server/utils/auth'

const USER = {
  id: 'user-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  avatarUrl: 'https://example.com/a.png',
  role: 'user',
}

describe('buildSessionPayload', () => {
  it('writes exactly the declared top-level keys — no more, no fewer', () => {
    // Both directions matter. A missing key is a field the previous session's
    // value survives into; an extra one is a field nothing declared and the
    // client type does not know about.
    expect(Object.keys(buildSessionPayload(USER)).sort()).toEqual([...SESSION_PAYLOAD_KEYS].sort())
  })

  it('carries only the five identity fields, and no others from the row', () => {
    // The session is a cookie on every request. Entitlements, attribution, and
    // referral codes are all on the same `users` row and none of them belong
    // here — read state from the database, keep identity in the cookie.
    expect(
      Object.keys(buildSessionPayload({ ...USER, referralCode: 'ABC' } as never).user).sort(),
    ).toEqual(['avatarUrl', 'email', 'id', 'name', 'role'])
  })

  it('does not preserve a null avatar as absent', () => {
    // The specific thing `setUserSession` got wrong: defu skips nulls, so a
    // null avatar would have inherited the previous account's picture. An
    // explicit null has to survive into the payload.
    expect(buildSessionPayload({ ...USER, avatarUrl: null }).user.avatarUrl).toBeNull()
  })

  it('dates the session in seconds, to match the revocation watermark', () => {
    // `users.sessions_invalid_before` is a D1 timestamp column, which is epoch
    // SECONDS. Milliseconds here would make every session look far newer than
    // any watermark and quietly disable revocation entirely.
    const payload = buildSessionPayload(USER, Date.parse('2026-06-01T12:00:00.750Z'))
    expect(payload.issuedAt).toBe(Math.floor(Date.parse('2026-06-01T12:00:00Z') / 1000))
  })
})

// ── Nothing after the session write may fail the sign-in ────────────────────
// Once the cookie is sealed the user IS signed in — but the caller is still
// inside completeOAuthSignIn's try/catch, which turns any throw into
// `sign_in_failed`. On the magic-link path that is unrecoverable: the token was
// consumed one statement earlier, so the person is told sign-in failed and
// their link is already spent.
//
// The welcome-email tail looked safe because sendEmail never throws — but
// isNotificationEnabled is a D1 read and buildUnsubscribeUrl is an HKDF
// derivation that throws on a missing session password. A welcome email is not
// allowed to cost somebody their account.

describe('afterSignIn', () => {
  it('swallows a throwing tail instead of failing the sign-in', async () => {
    await expect(
      afterSignIn('welcome_email', () => Promise.reject(new Error('D1 read failed'))),
    ).resolves.toBeUndefined()
  })

  it('swallows a synchronous throw too', async () => {
    await expect(
      afterSignIn('welcome_email', () => {
        throw new Error('HKDF: session password is empty')
      }),
    ).resolves.toBeUndefined()
  })

  it('says so in the log rather than passing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await afterSignIn('welcome_email', () => Promise.reject(new Error('boom')))
      const line = JSON.parse(String(warn.mock.calls[0]?.[0]))
      expect(line).toMatchObject({ kind: 'after_sign_in_failed', label: 'welcome_email' })
      expect(String(line.error)).toContain('boom')
    } finally {
      warn.mockRestore()
    }
  })

  it('still awaits the work when it succeeds', async () => {
    // Awaited, not floated: Workers can tear down the isolate the moment the
    // response is sent, so a dangling promise here is a welcome email that
    // sometimes does not exist.
    let done = false
    await afterSignIn('welcome_email', async () => {
      await Promise.resolve()
      done = true
    })
    expect(done).toBe(true)
  })
})
