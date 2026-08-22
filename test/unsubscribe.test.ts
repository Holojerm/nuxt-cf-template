// One-click unsubscribe tokens: sign, verify, and every way a forged or
// mismatched one has to be rejected. No D1 here — everything in
// server/utils/unsubscribe.ts that these functions touch is Web Crypto.

import { describe, expect, it } from 'vitest'
import {
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../server/utils/unsubscribe'

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
