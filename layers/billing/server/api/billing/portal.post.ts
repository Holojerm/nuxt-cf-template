// Mint Stripe customer-portal links for the signed-in user.
//
// This is the cancellation path: /account calls it and sends the user straight
// to Stripe's hosted portal (deep-linked to "cancel subscription" when they
// have a live one). Nobody should have to email us to stop paying. A cancel
// there ends the subscription at the period end, which is the portal's setting
// and the layer's expectation: the customer keeps what they paid for.
//
// Links are short-lived sessions, so we mint on click and never cache.
// Requires NUXT_STRIPE_SECRET_KEY; without it the route 503s and the page
// names the support address.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const config = useRuntimeConfig(event)
  const secretKey = config.stripe.secretKey
  if (!secretKey) {
    // Required config, not an optional feature: this route IS the cancel path.
    logEvent('error', 'stripe_portal_unconfigured')
    throw createError({
      statusCode: 503,
      message: 'Billing portal not configured',
      data: { code: 'portal_unconfigured' },
    })
  }

  const overview = await getBillingOverview(db, user.id)
  if (!overview.providerCustomerId) {
    throw createError({
      statusCode: 404,
      message: 'No billing history',
      data: { code: 'no_billing_history' },
    })
  }

  try {
    return await createPortalLinks({
      secretKey,
      apiBase: config.stripe.apiBase,
      customerId: overview.providerCustomerId,
      returnUrl: `${getRequestURL(event).origin}/account`,
      subscriptionId: overview.cancellableSubscriptionIds[0] ?? null,
    })
  } catch (error) {
    const stripe = error instanceof StripeApiError ? error : null
    logEvent('error', 'stripe_portal_failed', {
      status: stripe?.status ?? 0,
      code: stripe?.code ?? null,
    })
    throw createError({
      statusCode: 502,
      message: 'Could not reach Stripe',
      data: { code: 'portal_failed' },
    })
  }
})
