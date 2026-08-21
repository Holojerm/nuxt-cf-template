// The signed-in user's entitlement status — feeds the client-side subscription
// gate (app/middleware/subscription.ts), the pricing page, and /account.
// Auth-only on purpose: unsubscribed users must be able to ask "am I
// subscribed?".

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const overview = await getBillingOverview(db, user.id)
  const active = overview.active
  return {
    active: Boolean(active),
    status: active?.status ?? null,
    currentPeriodEnd: active?.currentPeriodEnd?.toISOString() ?? null,
    // 'pass' = one-time 30-day, nothing to cancel; 'subscription' = renewing.
    kind: active ? (isPass(active.paddleSubscriptionId) ? 'pass' : 'subscription') : null,
    /** Live subscriptions the user can cancel (usually 0 or 1). */
    cancellable: overview.subscriptionIds.length,
    /** Whether a Paddle customer portal link can be minted at all. */
    portalAvailable: Boolean(overview.paddleCustomerId && useRuntimeConfig().paddle.apiKey),
    history: overview.history.map((e) => ({
      ref: e.paddleSubscriptionId,
      kind: isPass(e.paddleSubscriptionId) ? 'pass' : 'subscription',
      status: e.status,
      currentPeriodEnd: e.currentPeriodEnd?.toISOString() ?? null,
      purchasedAt: e.createdAt.toISOString(),
    })),
  }
})
