// Stripe hosted Checkout: a redirect, not an overlay. startCheckout() asks the
// server for a Checkout Session (layers/billing/server/api/billing/checkout.post.ts)
// and sends the browser to the URL it returns; Stripe sends it back to
// /pricing?checkout=success or ?checkout=canceled. No Stripe script is loaded.
//
// The server decides who is buying (the session) and what is sold (the plan's
// price id from its own config), so nothing here can change either. Access
// itself arrives with the webhook, never with this redirect.

import { CHECKOUT_STARTED, CHECKOUT_UNAVAILABLE } from '../utils/checkout'

type Capture = (event: string, properties?: Record<string, unknown>) => void

export function useCheckout() {
  const { user } = useUserSession()

  // `$posthog` is undefined whenever posthogKey is unset, in which case every
  // checkout event quietly goes nowhere, like the rest of the analytics.
  const posthog = useNuxtApp().$posthog as { capture: Capture } | undefined
  const capture: Capture | null = posthog
    ? (event, properties) => posthog.capture(event, properties)
    : null

  /**
   * Start a purchase. Resolves false when checkout could not be started (the
   * caller shows a toast naming the support address); on success the browser is
   * already leaving the page.
   *
   * @param context extra properties for `checkout_started`.
   *
   * The seam an experiment needs. `checkout_started` is the funnel's
   * denominator, so anything that changes which plan a person clicks has to
   * travel on THAT event or the variant cannot be joined to the outcome.
   * Strings only, merged into one event.
   */
  async function startCheckout(plan: 'monthly' | 'pass', context: Record<string, string> = {}) {
    // The funnel's denominator, and deliberately the first thing that happens:
    // counting from anything later would exclude the people who never got a
    // checkout at all.
    capture?.(CHECKOUT_STARTED, {
      product_key: 'default',
      plan_id: plan,
      signed_in: Boolean(user.value?.id),
      ...context,
    })

    try {
      const { url } = await $fetch<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        body: { plan },
      })
      await navigateTo(url, { external: true })
      return true
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number }).statusCode
      const code = (error as { data?: { data?: { code?: string } } }).data?.data?.code
      capture?.(CHECKOUT_UNAVAILABLE, {
        product_key: 'default',
        plan_id: plan,
        status,
        code,
      })
      return false
    }
  }

  return { startCheckout }
}
