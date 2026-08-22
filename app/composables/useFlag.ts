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
//
// ── `settled` ──────────────────────────────────────────────────────────────
// A caller that only ever renders the value gets to ignore this. It exists for
// a different job: recording an analytics event tagged with which arm a
// visitor saw, exactly once (server/utils/onboarding.ts › recordActivationOnce
// is the concrete example this was built for). That job cannot use "the value
// changed" as its signal to fire, and the reason is stronger than a timing
// coincidence: posthog-js's `getFeatureFlag`/`isFeatureEnabled` deterministically
// return `undefined` — not a stale-then-corrected pair — until the `/flags`
// round trip actually completes (it logs "Feature flags didn't load in time"
// while that's true). For a cold-cache visitor — no prior page load in this
// browser to have cached a decision — that is EVERY mount, not a race. A
// one-shot side effect gated on "the ref changed" never fires for that
// visitor: the ref never leaves the fallback within the window the effect is
// watching, so nothing is ever observed to change, and the guard it trips
// records the fallback forever.
//
// `settled` names the actual thing that matters: has PostHog reported
// flags for this page load (`onFeatureFlags` fired), or is it confirmed to
// have nothing to report (unconfigured or blocked — resolved immediately,
// since the fallback IS final in that case)? A blocked or slow `/flags`
// request is bounded by FLAGS_SETTLE_TIMEOUT_MS so `settled` doesn't wedge
// false forever either — it marks true on the fallback, which is the honest
// answer: that's what was actually rendered the whole time. Gate a one-shot
// side effect on `settled && <your condition>`, never on watching the value
// change.

import type { PostHog } from 'posthog-js'
import type { Ref } from 'vue'
import { onMounted, onScopeDispose, readonly, ref } from 'vue'

function client(): PostHog | undefined {
  return useNuxtApp().$posthog as PostHog | undefined
}

/**
 * How long a blocked or slow PostHog `/flags` request gets before `settled`
 * gives up and marks itself true anyway (still holding the fallback value —
 * see the module comment). Chosen to comfortably exceed a normal decide
 * round trip while staying well short of "a visitor completed something and
 * is still on the page" — the realistic window a one-shot activation event
 * has to fire in.
 */
export const FLAGS_SETTLE_TIMEOUT_MS = 3000

/**
 * The core "read a flag, and know when to stop waiting for a better answer"
 * state machine, decoupled from Vue's `onMounted`/`onScopeDispose` so it can
 * be driven directly in a test with a fake PostHog — see
 * test/use-flag.test.ts. `useFlag()`/`useFlagVariant()` below are thin
 * lifecycle wrappers around this; there is no Nuxt-specific logic here to
 * re-test through them.
 *
 * Mutates the `value`/`settled` refs the caller already owns (rather than
 * creating and returning its own) because those refs have to exist
 * synchronously, at composable-call time — before `onMounted` ever runs — so
 * `useFlag`/`useFlagVariant` have something to return immediately.
 *
 * Returns a `dispose` function; the caller is responsible for wiring it to
 * `onScopeDispose`.
 */
export function trackFlagSettle<T>(
  posthog: PostHog | undefined,
  value: Ref<T>,
  settled: Ref<boolean>,
  read: (posthog: PostHog) => T,
): () => void {
  if (!posthog) {
    // Nothing to wait for — the fallback `value` already holds IS the final
    // answer when PostHog is unconfigured or an ad blocker ate the SDK.
    settled.value = true
    return () => {}
  }

  const apply = () => {
    value.value = read(posthog)
  }
  // Flags may already be cached from an earlier page load in this browser,
  // in which case this returns the real value immediately — or they may
  // not be, in which case this is the harmless "still the fallback" call
  // the module comment describes. Either way, onFeatureFlags below is what
  // actually resolves `settled`.
  apply()

  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const markSettled = () => {
    if (settled.value) return
    settled.value = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }

  // Fires synchronously if flags are already loaded (in which case
  // markSettled below sees settled.value already true and the timeout is
  // never even scheduled), or later, once the in-flight /flags request
  // resolves.
  const unsubscribe = posthog.onFeatureFlags(() => {
    apply()
    markSettled()
  })

  if (!settled.value) {
    timeoutId = setTimeout(markSettled, FLAGS_SETTLE_TIMEOUT_MS)
  }

  return () => {
    unsubscribe?.()
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export interface UseFlagResult {
  enabled: Readonly<Ref<boolean>>
  settled: Readonly<Ref<boolean>>
}

/**
 * Reactive boolean for a feature flag.
 *
 *   const { enabled } = useFlag('new-onboarding')
 *
 * `enabled` returns `fallback` during SSR, during hydration, and whenever
 * PostHog is unconfigured or blocked — so the control path is what every
 * visitor gets if anything at all goes wrong. Make the fallback the
 * safe/current behaviour.
 *
 * `settled` is false until that's known for certain — see the module
 * comment for why a one-shot side effect (an analytics event, not a render)
 * must gate on it instead of on `enabled` changing.
 */
export function useFlag(key: string, fallback = false): UseFlagResult {
  const enabled = ref(fallback) as Ref<boolean>
  const settled = ref(false)

  onMounted(() => {
    const dispose = trackFlagSettle(
      client(),
      enabled,
      settled,
      (posthog) => posthog.isFeatureEnabled(key) ?? fallback,
    )
    onScopeDispose(dispose)
  })

  return { enabled: readonly(enabled), settled: readonly(settled) }
}

/**
 * Normalizes a raw PostHog flag value to one of `allowed`, or `fallback`.
 * Exported for direct testing (test/use-flag.test.ts) alongside
 * trackFlagSettle — this is the other piece of useFlagVariant's logic that
 * has nothing to do with Vue.
 *
 * `allowed` is optional: omit it and any string PostHog returns is accepted
 * as-is (the pre-existing behaviour). Pass it and anything outside the list
 * — including a brand-new arm added in the PostHog dashboard but not yet
 * added here — clamps to `fallback`, both in what renders and in what a
 * caller records. See useFlagVariant's own comment for why "clamped" is the
 * safe failure mode rather than "pass it through and let the recipient
 * reject it".
 */
export function resolveFlagVariant(
  raw: unknown,
  fallback: string,
  allowed?: readonly string[],
): string {
  if (typeof raw !== 'string') return fallback
  if (allowed && !allowed.includes(raw)) return fallback
  return raw
}

export interface UseFlagVariantResult {
  variant: Readonly<Ref<string>>
  settled: Readonly<Ref<boolean>>
}

/**
 * Reactive variant key for a multivariate flag — the A/B/n case.
 *
 *   const { variant } = useFlagVariant('pricing-layout', 'control')
 *
 * PostHog returns `true`/`false` for boolean flags and a string for
 * multivariate ones; this normalizes to a string so callers can switch on it.
 *
 * `allowed`, if given, bounds the result to a known set of arms — pass it
 * whenever `variant` is going to ride along on something with its own
 * closed vocabulary (a Zod enum in an API body, a database column). Without
 * it, adding a new arm in the PostHog dashboard before the code that
 * consumes it knows about that arm means every visitor bucketed into it
 * gets served — and, if a caller records this value — permanently tagged
 * with a variant nothing downstream recognizes. Clamping to `fallback`
 * instead means a not-yet-supported arm silently degrades to the control
 * experience until the code catches up, rather than failing loudly (or
 * worse, quietly losing the outcome data) for every visitor in it.
 *
 * `settled` is false until PostHog has actually reported flags (or is
 * confirmed to have nothing to report) — see the module comment.
 */
export function useFlagVariant(
  key: string,
  fallback = 'control',
  allowed?: readonly string[],
): UseFlagVariantResult {
  const variant = ref(fallback) as Ref<string>
  const settled = ref(false)

  onMounted(() => {
    const dispose = trackFlagSettle(client(), variant, settled, (posthog) =>
      resolveFlagVariant(posthog.getFeatureFlag(key), fallback, allowed),
    )
    onScopeDispose(dispose)
  })

  return { variant: readonly(variant), settled: readonly(settled) }
}
