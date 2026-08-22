// Credentials must never reach the analytics warehouse.
//
// This is the last of four layers (see app/utils/analytics-privacy.ts), and the
// only one that can catch what autocapture reads straight out of
// `window.location.href`. The inputs below are the real property shapes
// posthog-js emits — `$current_url`, `$referrer`, and the `$set_once` bag that
// pins `$initial_current_url` to a person profile permanently rather than to
// one event.

import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_PRIVACY_OPTIONS,
  REDACTED,
  sanitizeAnalyticsProperties,
  scrubUrl,
} from '../app/utils/analytics-privacy'

// The plugin's own text. Vite resolves `?raw` at transform time, which is what
// makes this readable from inside workerd, where there is no filesystem — the
// same trick test/turnstile.test.ts uses for the mint route's call ordering.
import PLUGIN_SOURCE from '../app/plugins/posthog.client.ts?raw'

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

// ── The init options, because a missing flag is silent ──────────────────────
// `sanitize_properties` does not run for session replay. posthog-js returns
// early from `calculateEventProperties` for `$snapshot`, BEFORE the hook — and
// rrweb's Meta event, emitted with every full snapshot, carries
// `window.location.href` including the fragment. So a replay of a magic-link
// sign-in recorded the live token even with the sanitizer in place.
//
// Nothing about that failure is visible from the app: the recording looks fine,
// the sanitizer is demonstrably working on ordinary events, and the token is
// only there if you open the replay and read the URL bar it drew. Which is why
// the options are a value that can be asserted rather than a literal buried in
// a plugin.

describe('ANALYTICS_PRIVACY_OPTIONS', () => {
  it('disables URL-hash capture, the only switch replay honours', () => {
    // The fragment is where every credential in this app lives.
    expect(ANALYTICS_PRIVACY_OPTIONS.disable_capture_url_hashes).toBe(true)
  })

  it('scrubs the query form off recorded network requests too', () => {
    // The hash flag does not touch query strings, and the unsubscribe link's
    // signed token is a query parameter by RFC 8058's requirement.
    const mask = ANALYTICS_PRIVACY_OPTIONS.session_recording.maskCapturedNetworkRequestFn
    const masked = mask({
      name: `https://app.example.com/auth/verify?token=${TOKEN}`,
      entryType: 'resource',
      startTime: 0,
      duration: 1,
    } as never)

    expect(JSON.stringify(masked)).not.toContain(TOKEN)
    // Everything else about the entry survives — this masks a URL, it does not
    // drop the request.
    expect(masked).toMatchObject({ entryType: 'resource', duration: 1 })
  })

  it('leaves a request with no name untouched rather than throwing', () => {
    const mask = ANALYTICS_PRIVACY_OPTIONS.session_recording.maskCapturedNetworkRequestFn
    expect(() => mask({ entryType: 'resource', startTime: 0, duration: 1 } as never)).not.toThrow()
  })

  it('still carries the sanitizer and the replay masking rules', () => {
    // All three live in one object precisely so they cannot be half-applied by
    // someone editing the plugin's session_recording block in isolation.
    expect(ANALYTICS_PRIVACY_OPTIONS.sanitize_properties).toBe(sanitizeAnalyticsProperties)
    expect(ANALYTICS_PRIVACY_OPTIONS.session_recording.maskAllInputs).toBe(true)
    expect(ANALYTICS_PRIVACY_OPTIONS.session_recording.maskTextSelector).toBe('[data-private]')
  })

  it('is actually spread into posthog.init — not merely exported', () => {
    // The object is only worth anything if the plugin uses it, and the plugin
    // cannot be imported here (it calls Nuxt composables at module scope). Its
    // source is the next best witness, and it fails loudly if someone
    // reintroduces a literal session_recording block alongside the spread.
    expect(PLUGIN_SOURCE).toContain('...ANALYTICS_PRIVACY_OPTIONS')
    expect(PLUGIN_SOURCE).not.toMatch(/^\s*session_recording:/m)
  })
})
