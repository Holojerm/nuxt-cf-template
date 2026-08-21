// Checkout funnel event mapping.
//
// Paddle's overlay is a cross-origin iframe, so PostHog's autocapture cannot
// see a single thing that happens inside it. Without the `eventCallback` these
// names come from, the funnel reads:
//
//   user_signed_up → ( nothing at all ) → paddle_subscription_created
//
// which makes checkout abandonment — usually the highest-leverage conversion
// number a SaaS has — literally uncomputable. These events fill that gap.
//
// ── These are signals, not revenue ───────────────────────────────────────────
// They fire from the browser, so an ad blocker can drop them. That is fine for
// what they're for: `checkout_completed` here is a UX signal, and the Paddle
// webhook (server/routes/paddle/webhook.post.ts) remains the only thing that
// decides whether anybody actually paid. Never reconcile money against these.

/** Paddle.js v2 event names → the names we record. */
export const CHECKOUT_EVENT_NAMES: Record<string, string> = {
  'checkout.loaded': 'checkout_loaded',
  'checkout.customer.created': 'checkout_customer_created',
  'checkout.payment.initiated': 'checkout_payment_initiated',
  'checkout.payment.failed': 'checkout_payment_failed',
  'checkout.completed': 'checkout_completed',
  'checkout.error': 'checkout_error',
}

/** Emitted when the overlay closes without a completed payment. */
export const CHECKOUT_ABANDONED = 'checkout_abandoned'

/**
 * Which event (if any) a Paddle event should produce.
 *
 * The one piece of real logic: `checkout.closed` fires both when someone gives
 * up AND immediately after a successful payment. Reporting those as one event
 * makes the abandonment rate meaningless, so a close that follows a completion
 * is dropped — `checkout_completed` already told that story.
 *
 * Pure, for test/checkout.test.ts.
 */
export function resolveCheckoutEvent(paddleEvent: string, hasCompleted: boolean): string | null {
  if (paddleEvent === 'checkout.closed') {
    return hasCompleted ? null : CHECKOUT_ABANDONED
  }
  return CHECKOUT_EVENT_NAMES[paddleEvent] ?? null
}

/**
 * The subset of Paddle's event payload that is safe to send to analytics.
 *
 * Allowlisted, never spread. Paddle's `data` carries the customer's email and
 * billing address, and forwarding the object wholesale would quietly copy
 * personal data into a third party on every checkout — the kind of leak that
 * passes code review because it looks like one line of plumbing.
 */
export function checkoutEventProperties(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {}
  const d = data as {
    items?: { price_id?: string; quantity?: number }[]
    currency_code?: string
    totals?: { total?: string | number }
  }
  return {
    price_ids: Array.isArray(d.items) ? d.items.map((i) => i.price_id).filter(Boolean) : [],
    item_count: Array.isArray(d.items) ? d.items.length : 0,
    currency: d.currency_code,
    total: d.totals?.total,
  }
}
