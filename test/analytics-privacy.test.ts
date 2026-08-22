// Credentials must never reach the analytics warehouse.
//
// This is the last of four layers (see app/utils/analytics-privacy.ts), and the
// only one that can catch what autocapture reads straight out of
// `window.location.href`. The inputs below are the real property shapes
// posthog-js emits — `$current_url`, `$referrer`, and the `$set_once` bag that
// pins `$initial_current_url` to a person profile permanently rather than to
// one event.

import { describe, expect, it } from 'vitest'

import { REDACTED, sanitizeAnalyticsProperties, scrubUrl } from '../app/utils/analytics-privacy'

/** 43 base64url characters — the real shape of a magic-link token. */
const TOKEN = 'RVZuBk3ZbgpqJcT-nBcmLfU0TnUUxBCGblIsSLBPxB8'

describe('scrubUrl', () => {
  it('redacts a sign-in token in the query string', () => {
    const scrubbed = scrubUrl(`https://app.example.com/auth/verify?token=${TOKEN}`)
    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed).toBe(`https://app.example.com/auth/verify?token=${REDACTED}`)
  })

  it('redacts a sign-in token in the fragment, which is where real links put it', () => {
    // `location.href` includes the fragment, and autocapture sends exactly that.
    const scrubbed = scrubUrl(`https://app.example.com/auth/verify#token=${TOKEN}`)
    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed).toBe(`https://app.example.com/auth/verify#token=${REDACTED}`)
  })

  it('redacts every unsubscribe parameter', () => {
    const scrubbed = scrubUrl('/unsubscribe#u=user-1&e=welcome&t=signed-token-value')
    expect(scrubbed).not.toContain('signed-token-value')
    expect(scrubbed).not.toContain('user-1')
    expect(scrubbed).toBe(`/unsubscribe#u=${REDACTED}&e=${REDACTED}&t=${REDACTED}`)
  })

  it('works on a bare path, not just an absolute URL', () => {
    // `$pathname` and hand-built properties arrive relative; a scrubber built on
    // `new URL()` would throw on these and pass them through untouched.
    expect(scrubUrl(`/auth/verify?token=${TOKEN}`)).toBe(`/auth/verify?token=${REDACTED}`)
  })

  it('leaves innocent URLs exactly as they were', () => {
    // Over-redaction costs analytics for nothing, so the sanitizer has to be
    // boring on the 99% of URLs that carry no credential.
    expect(scrubUrl('https://app.example.com/pricing')).toBe('https://app.example.com/pricing')
    expect(scrubUrl('https://app.example.com/pricing?plan=yearly&ref=blog')).toBe(
      'https://app.example.com/pricing?plan=yearly&ref=blog',
    )
  })

  it('leaves a plain anchor alone rather than mangling it into a parameter', () => {
    expect(scrubUrl('https://app.example.com/pricing#faq')).toBe(
      'https://app.example.com/pricing#faq',
    )
  })

  it('redacts only the sensitive parameter, keeping the rest readable', () => {
    const scrubbed = scrubUrl(`/auth/verify?utm_source=email&token=${TOKEN}`)
    expect(scrubbed).toContain('utm_source=email')
    expect(scrubbed).not.toContain(TOKEN)
  })

  it('never throws on input that is not a URL at all', () => {
    expect(scrubUrl('')).toBe('')
    expect(scrubUrl('not a url')).toBe('not a url')
    expect(scrubUrl('#')).toBe('#')
    expect(scrubUrl('?')).toBe('?')
  })
})

describe('sanitizeAnalyticsProperties', () => {
  it('scrubs the properties autocapture attaches to every single event', () => {
    // This is the actual leak: not $pageview (which we already capture as a bare
    // path) but every click, change, and dead-click autocapture records, each
    // carrying window.location.href.
    const sanitized = sanitizeAnalyticsProperties({
      $current_url: `https://app.example.com/auth/verify#token=${TOKEN}`,
      $pathname: '/auth/verify',
      $referrer: `https://app.example.com/auth/verify?token=${TOKEN}`,
      $event_type: 'click',
    })

    expect(JSON.stringify(sanitized)).not.toContain(TOKEN)
    expect(sanitized.$pathname).toBe('/auth/verify')
    // Non-URL properties are the whole point of the event and must survive.
    expect(sanitized.$event_type).toBe('click')
  })

  it('reaches into $set_once, where a token would stick to a person forever', () => {
    // An event property is one row. `$initial_current_url` is written onto the
    // person profile and stays there.
    const sanitized = sanitizeAnalyticsProperties({
      $set_once: { $initial_current_url: `https://app.example.com/auth/verify#token=${TOKEN}` },
      $set: { $current_url: `/unsubscribe#t=${TOKEN}` },
    })

    expect(JSON.stringify(sanitized)).not.toContain(TOKEN)
  })

  it('does not mutate the object posthog-js handed over', () => {
    const original = { $current_url: `/auth/verify#token=${TOKEN}` }
    sanitizeAnalyticsProperties(original)
    expect(original.$current_url).toContain(TOKEN)
  })

  it('leaves a properties bag with no URLs in it untouched', () => {
    const properties = { plan: 'yearly', amount: 120, $event_type: 'submit' }
    expect(sanitizeAnalyticsProperties(properties)).toEqual(properties)
  })
})
