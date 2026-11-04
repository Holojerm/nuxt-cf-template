// Feature flags over the already-loaded PostHog SDK; flags are created in the PostHog dashboard.
//
// The value starts at `fallback` through render and hydration and only moves in onMounted:
// PostHog is client-only and caches flags in localStorage, so reading it during setup would
// render markup that disagrees with SSR and Vue would discard the subtree. Swap content, not
// layout, so the one control-variant frame is not a flash; decisions that cannot tolerate it
// belong on the server.
//
// `settled` is for one-shot side effects (an event tagged with the arm seen): posthog-js returns
// `undefined` until `/flags` completes, so for a cold-cache visitor the value never visibly
// "changes" and a watch-the-value effect never fires. Gate on `settled && ...` instead.

import type { PostHog } from 'posthog-js'
import type { Ref } from 'vue'

function client(): PostHog | undefined {
  return useNuxtApp().$posthog as PostHog | undefined
}

/** How long `settled` waits on a blocked or slow `/flags` request before settling on the fallback. */
export const FLAGS_SETTLE_TIMEOUT_MS = 3000

/**
 * The flag-read and settle logic, separate from Vue lifecycle hooks so
 * test/use-flag.test.ts can drive it with a fake PostHog. Mutates caller-owned refs because
 * they must exist before `onMounted`; returns a dispose function for `onScopeDispose`.
 */
export function trackFlagSettle<T>(
  posthog: PostHog | undefined,
  value: Ref<T>,
  settled: Ref<boolean>,
  read: (posthog: PostHog) => T,
): () => void {
  if (!posthog) {
    // Unconfigured or blocked: the fallback is final.
    settled.value = true
    return () => {}
  }

  const apply = () => {
    value.value = read(posthog)
  }
  // Cached flags give the real value now; otherwise this is the harmless fallback read.
  apply()

  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const markSettled = () => {
    if (settled.value) return
    settled.value = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }

  // Fires synchronously when flags are already loaded, else when `/flags` resolves.
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
 * Reactive boolean flag: `fallback` during SSR/hydration and whenever PostHog is unconfigured
 * or blocked, so make the fallback the safe, current behaviour. See the module comment for `settled`.
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
 * Normalizes a raw PostHog flag value to one of `allowed` (any string if omitted), else `fallback`.
 * Exported for test/use-flag.test.ts.
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
 * Reactive variant key for a multivariate flag. Pass `allowed` whenever the value feeds a closed
 * vocabulary (Zod enum, DB column): an arm added in PostHog before the code knows it clamps to
 * `fallback` instead of tagging visitors with a variant nothing downstream recognizes.
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
