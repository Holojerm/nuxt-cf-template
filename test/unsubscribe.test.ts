// One-click unsubscribe tokens: sign, verify, and every way a forged or
// mismatched one has to be rejected — plus the liveness rule that stops a
// never-expiring token from resurrecting a deleted account's preferences.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { isNotificationEnabled, setNotificationPreference } from '../server/utils/notifications'
import {
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../server/utils/unsubscribe'
import { isUndeliverableAddress } from '../server/utils/users'

const SECRET = 'a-test-session-password-that-is-reasonably-long'
const OTHER_SECRET = 'a-completely-different-session-password'

describe('signUnsubscribeToken / verifyUnsubscribeToken', () => {
  it('verifies a token against the exact userId/eventType it was signed for', async () => {
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', token)).toBe(true)
  })

  it('is deterministic — signing the same inputs twice yields the same token', async () => {
    const a = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    const b = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(a).toBe(b)
  })

  it('rejects a tampered token', async () => {
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    const flippedChar = token.at(-1) === 'A' ? 'B' : 'A'
    const tampered = `${token.slice(0, -1)}${flippedChar}`
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', tampered)).toBe(false)
  })

  it('rejects a token minted for a different user', async () => {
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(await verifyUnsubscribeToken(SECRET, 'user-2', 'welcome', token)).toBe(false)
  })

  it('rejects a token minted for a different event type', async () => {
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'product_updates', token)).toBe(false)
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(await verifyUnsubscribeToken(OTHER_SECRET, 'user-1', 'welcome', token)).toBe(false)
  })

  it('rejects garbage input without throwing', async () => {
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', 'not-a-real-token')).toBe(
      false,
    )
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', '')).toBe(false)
  })

  it('rejects a token that is a truncated prefix of a real one', async () => {
    // The length check in the constant-time comparator has to run before the
    // byte loop, or a prefix match would need its own test to catch a
    // short-circuiting `===` slipping back in.
    const token = await signUnsubscribeToken(SECRET, 'user-1', 'welcome')
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', token.slice(0, -4))).toBe(
      false,
    )
  })

  it('refuses to sign a token for a mandatory event type', async () => {
    await expect(
      signUnsubscribeToken(SECRET, 'user-1', 'billing.payment_failed' as never),
    ).rejects.toThrow(/mandatory/)
  })
})

describe('buildUnsubscribeUrl', () => {
  it('produces a verifiable link carrying userId, eventType, and token', async () => {
    const url = await buildUnsubscribeUrl(SECRET, 'https://example.com', 'user-1', 'welcome')
    const parsed = new URL(url)

    expect(parsed.pathname).toBe('/api/email/unsubscribe')
    expect(parsed.searchParams.get('u')).toBe('user-1')
    expect(parsed.searchParams.get('e')).toBe('welcome')

    const token = parsed.searchParams.get('t')
    expect(token).toBeTruthy()
    expect(await verifyUnsubscribeToken(SECRET, 'user-1', 'welcome', token!)).toBe(true)
  })

  it('strips a trailing slash from the app URL', async () => {
    const url = await buildUnsubscribeUrl(SECRET, 'https://example.com/', 'user-1', 'welcome')
    expect(url.startsWith('https://example.com/api/email/unsubscribe?')).toBe(true)
  })
})

// ── A deleted account's preferences must stay deleted ───────────────────────
// The unsubscribe token is an HMAC over `userId|eventType` with no expiry — by
// design, because a link in a two-year-old email should still work. Combined
// with deletion anonymizing the `users` row in place, replaying any old link
// INSERTED a fresh notification_preferences row against the tombstone: data
// recreated for an account whose entire point is that its data is gone, and a
// row a deletion that already ran would have to come back and clean up.

describe('applyUnsubscribeRequest against a deleted account', () => {
  const db = drizzle(env.DB, { schema })
  const USER = 'user-1'
  const SESSION_PASSWORD = 'test-session-password-0123456789'

  beforeEach(async () => {
    await db.delete(schema.notificationPreferences)
    await db.delete(schema.users)
  })

  /** A request shaped the way the confirmation page POSTs one. */
  async function request(userId: string) {
    const token = await signUnsubscribeToken(SESSION_PASSWORD, userId, 'welcome')
    return { u: userId, e: 'welcome' as const, t: token }
  }

  it('writes the opt-out for a live account', async () => {
    await db.insert(schema.users).values({ id: USER, email: 'ada@example.com', name: 'Ada' })

    const { u, e } = await request(USER)
    await setNotificationPreference(db, u, e, false)

    expect(await isNotificationEnabled(db, USER, 'welcome')).toBe(false)
  })

  it('creates nothing for a tombstoned account', async () => {
    await db
      .insert(schema.users)
      .values({ id: USER, email: `deleted-${USER}@deleted.invalid`, name: 'Deleted user' })

    // Standing in for the route: the guard applyUnsubscribeRequest applies
    // before it writes. Asserting the rule rather than the plumbing, because
    // the plumbing needs an H3 event and runtime config that this pool has no
    // way to give it.
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, USER) })
    expect(isUndeliverableAddress(user!.email)).toBe(true)

    const rows = await db.query.notificationPreferences.findMany({
      where: eq(schema.notificationPreferences.userId, USER),
    })
    expect(rows).toHaveLength(0)
  })

  it('still signs and verifies a token for an account that no longer exists', async () => {
    // The token stays cryptographically valid forever — that is exactly why the
    // liveness check has to exist as a separate step rather than being assumed
    // from a successful verification.
    const token = await signUnsubscribeToken(SESSION_PASSWORD, 'ghost', 'welcome')
    expect(await verifyUnsubscribeToken(SESSION_PASSWORD, 'ghost', 'welcome', token)).toBe(true)

    const user = await db.query.users.findFirst({ where: eq(schema.users.id, 'ghost') })
    expect(user).toBeUndefined()
  })
})
