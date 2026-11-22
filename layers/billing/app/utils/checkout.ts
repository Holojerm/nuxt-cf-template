// The checkout funnel's names and the return from Stripe.
//
// Stripe's hosted Checkout is a full-page redirect, so PostHog sees the whole
// journey on our pages except the payment itself. `checkout_started` fires
// when the button is pressed, and the redirect back to /pricing says how it
// ended: `?checkout=success` or `?checkout=canceled`.
//
// ── These are signals, not revenue ───────────────────────────────────────────
// They fire from the browser, so an ad blocker can drop them, and the return
// URL can be typed by anyone. That is fine for a UX funnel; the Stripe webhook
// (layers/billing/server/routes/stripe/webhook.post.ts) remains the only thing
// that decides whether anybody paid. Never reconcile money against these.

export const CHECKOUT_STARTED = 'checkout_started'
export const CHECKOUT_UNAVAILABLE = 'checkout_unavailable'
export const CHECKOUT_COMPLETED = 'checkout_completed'
export const CHECKOUT_ABANDONED = 'checkout_abandoned'

export type CheckoutReturn = 'success' | 'canceled'

/** What the `checkout` query parameter on /pricing says, or null for any other value. */
export function checkoutReturnState(query: Record<string, unknown>): CheckoutReturn | null {
  const value = Array.isArray(query.checkout) ? query.checkout[0] : query.checkout
  return value === 'success' || value === 'canceled' ? value : null
}
