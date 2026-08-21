// Feature flags, over the PostHog SDK that is already loaded.
//
// The gap this fills: with no flag mechanism, every change ships to 100% of
// users at once and the only way to evaluate it is to look at a weekly number
// and guess. Flags are what make the "iterate" half of the loop a measurement
// rather than an argument.
//
// Flags are created in the PostHog dashboard, not in code — no deploy is
// needed to roll one out, roll it back, or point it at a cohort.
//
// ── Why the value always starts at the fallback ──────────────────────────────
// This is the part that is easy to get wrong. PostHog is client-only and caches
// flags in localStorage, so `isFeatureEnabled` can answer instantly in the
// browser while the server rendered nothing of the sort. Reading it during
// setup would therefore produce markup that disagrees with the SSR output, and
// Vue would discard the mismatched subtree — a hydration bug that reproduces
// only for users who have visited before.
//
// So: the ref holds `fallback` through render AND initial hydration, and only
// moves in onMounted. The cost is one frame of the control variant. Pay it —
// design the flagged UI so that frame is not a visible flash (swap content, not
// layout), or gate on it behind an explicit user action.
//
// For anything where the flash is unacceptable, the honest answer is that the
// decision belongs on the server: read it in an API route and send the result
// down with the page data.

import type { PostHog } from 'posthog-js'

function client(): PostHog | undefined {
  return useNuxtApp().$posthog as PostHog | undefined
}

/**
 * Reactive boolean for a feature flag.
 *
 *   const showNewOnboarding = useFlag('new-onboarding')
 *
 * Returns `fallback` during SSR, during hydration, and whenever PostHog is
 * unconfigured or blocked — so the control path is what every visitor gets if
 * anything at all goes wrong. Make the fallback the safe/current behaviour.
 */
export function useFlag(key: string, fallback = false): Readonly<Ref<boolean>> {
  const enabled = ref(fallback)

  onMounted(() => {
    const posthog = client()
    if (!posthog) return

    const read = () => {
      enabled.value = posthog.isFeatureEnabled(key) ?? fallback
    }

    // Flags may already be in hand (localStorage) or still in flight;
    // onFeatureFlags fires on load and on every subsequent refresh.
    read()
    const unsubscribe = posthog.onFeatureFlags(read)
    onScopeDispose(() => unsubscribe?.())
  })

  return readonly(enabled)
}

/**
 * Reactive variant key for a multivariate flag — the A/B/n case.
 *
 *   const pricingLayout = useFlagVariant('pricing-layout', 'control')
 *
 * PostHog returns `true`/`false` for boolean flags and a string for
 * multivariate ones; this normalizes to a string so callers can switch on it.
 */
export function useFlagVariant(key: string, fallback = 'control'): Readonly<Ref<string>> {
  const variant = ref(fallback)

  onMounted(() => {
    const posthog = client()
    if (!posthog) return

    const read = () => {
      const value = posthog.getFeatureFlag(key)
      variant.value = typeof value === 'string' ? value : fallback
    }

    read()
    const unsubscribe = posthog.onFeatureFlags(read)
    onScopeDispose(() => unsubscribe?.())
  })

  return readonly(variant)
}
