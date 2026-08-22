// app/composables/useFlag.ts's pure logic — trackFlagSettle and
// resolveFlagVariant — driven directly with a fake PostHog rather than
// through the real Nuxt composables. useFlag()/useFlagVariant() themselves
// are thin onMounted/onScopeDispose wrappers with nothing left to test once
// this is covered: they only add `client()` (a Nuxt auto-import lookup) and
// the lifecycle wiring, neither of which has logic of its own.
//
// The property worth testing hardest is the one the whole `settled` signal
// exists for: posthog-js's `getFeatureFlag`/`isFeatureEnabled` return
// `undefined` DETERMINISTICALLY — not intermittently — until its `/flags`
// request actually completes. For a cold-cache visitor (nothing cached from
// an earlier page load in this browser) that is true for the ENTIRE window
// a naive "fire when the value changes" effect would be watching, which is
// why the fake PostHog below models that gate explicitly (`loaded`) rather
// than just returning canned values.

import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLAGS_SETTLE_TIMEOUT_MS,
  resolveFlagVariant,
  trackFlagSettle,
} from '../app/composables/useFlag'
import type { PostHog } from 'posthog-js'

interface FakePostHogOptions {
  flags?: Record<string, string | boolean>
  /** Simulates a page load where PostHog already had flags cached from an
   * earlier visit — onFeatureFlags fires synchronously on registration,
   * the way the real SDK does when it already has a decision in hand. */
  alreadyLoaded?: boolean
}

function createFakePostHog(options: FakePostHogOptions = {}) {
  let loaded = Boolean(options.alreadyLoaded)
  const callbacks: Array<() => void> = []

  return {
    // Matches posthog-js exactly: both return undefined until the /flags
    // response has actually landed — never a stale-then-corrected pair.
    isFeatureEnabled: (key: string) => (loaded ? options.flags?.[key] : undefined),
    getFeatureFlag: (key: string) => (loaded ? options.flags?.[key] : undefined),
    onFeatureFlags: (callback: () => void) => {
      callbacks.push(callback)
      if (loaded) callback()
      return () => {
        const index = callbacks.indexOf(callback)
        if (index >= 0) callbacks.splice(index, 1)
      }
    },
    /** Test-only: simulates the /flags round trip completing. */
    resolveFlags(flags?: Record<string, string | boolean>) {
      if (flags) options.flags = flags
      loaded = true
      for (const callback of [...callbacks]) callback()
    },
  }
}

describe('trackFlagSettle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles immediately when PostHog is undefined — the fallback is final', () => {
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(undefined, value, settled, () => 'compact')

    expect(settled.value).toBe(true)
    expect(value.value).toBe('control')
  })

  it('is the cold-cache case, not a race: stays unsettled and on the fallback with nothing observed to change', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )

    // Exactly the deterministic-undefined behavior the module comment
    // describes: the synchronous first read already ran and found nothing.
    expect(settled.value).toBe(false)
    expect(value.value).toBe('control')
  })

  it('settles and updates the value once flags actually arrive', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )

    posthog.resolveFlags()

    expect(settled.value).toBe(true)
    expect(value.value).toBe('compact')
  })

  it('settles synchronously when flags are already cached from an earlier page load', () => {
    const posthog = createFakePostHog({
      alreadyLoaded: true,
      flags: { 'onboarding-layout': 'compact' },
    })
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )

    expect(settled.value).toBe(true)
    expect(value.value).toBe('compact')
  })

  it('bounds a blocked or slow /flags request with a timeout — settled true, value still the fallback', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )

    expect(settled.value).toBe(false)
    vi.advanceTimersByTime(FLAGS_SETTLE_TIMEOUT_MS)

    // Settled true — but the value is still whatever actually rendered
    // (the fallback), not a value that was silently invented.
    expect(settled.value).toBe(true)
    expect(value.value).toBe('control')
  })

  it('does not let a late /flags response after the timeout un-fire or overwrite settled', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )

    vi.advanceTimersByTime(FLAGS_SETTLE_TIMEOUT_MS)
    expect(settled.value).toBe(true)

    // A late response can still update the value (better late than never
    // for rendering purposes) — but settled was already true and stays true.
    posthog.resolveFlags()
    expect(settled.value).toBe(true)
    expect(value.value).toBe('compact')
  })

  it('clears the timeout once flags resolve first, so it never fires later', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )
    posthog.resolveFlags()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })

  it('dispose tears down the subscription — a later flags event no longer settles anything', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    const dispose = trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )
    dispose()
    posthog.resolveFlags()

    expect(settled.value).toBe(false)
    expect(value.value).toBe('control')
  })

  it('dispose also clears the pending timeout', () => {
    const posthog = createFakePostHog({ flags: { 'onboarding-layout': 'compact' } })
    const value = ref('control')
    const settled = ref(false)

    const dispose = trackFlagSettle(posthog as unknown as PostHog, value, settled, (ph) =>
      resolveFlagVariant(ph.getFeatureFlag('onboarding-layout'), 'control'),
    )
    dispose()
    vi.advanceTimersByTime(FLAGS_SETTLE_TIMEOUT_MS)

    expect(settled.value).toBe(false)
  })
})

describe('resolveFlagVariant', () => {
  it('passes through any string when no allowlist is given', () => {
    expect(resolveFlagVariant('anything-goes', 'control')).toBe('anything-goes')
  })

  it('falls back for a non-string value (undefined, boolean) regardless of allowlist', () => {
    expect(resolveFlagVariant(undefined, 'control')).toBe('control')
    expect(resolveFlagVariant(true, 'control')).toBe('control')
    expect(resolveFlagVariant(false, 'control', ['control', 'compact'])).toBe('control')
  })

  it('passes through a value that is in the allowlist', () => {
    expect(resolveFlagVariant('compact', 'control', ['control', 'compact'])).toBe('compact')
  })

  it('clamps a value outside the allowlist to the fallback — the new-arm-not-yet-shipped case', () => {
    // This is the exact scenario the review found: a third arm configured
    // in PostHog before the code (here, the allowlist) knows about it.
    expect(resolveFlagVariant('compact-v2', 'control', ['control', 'compact'])).toBe('control')
  })
})
