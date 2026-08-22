// Mint a Paddle customer-portal link for the signed-in user.
//
// This is the cancellation path: /account calls it and sends the user straight
// to Paddle's hosted portal (deep-linked to "cancel subscription" when they
// have a live one). Nobody should have to email us to stop paying.
//
// Links are single-use-ish and short-lived, so we mint on click and never
// cache. Requires NUXT_PADDLE_API_KEY; without it the route 503s and the page
// shows the receipt-email fallback.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const config = useRuntimeConfig()
  const apiKey = config.paddle.apiKey
  if (!apiKey) {
    throw createError({
      statusCode: 503,
      message: 'Billing portal not configured',
      data: { code: 'portal_unconfigured' },
    })
  }

  const overview = await getBillingOverview(db, user.id)
  if (!overview.paddleCustomerId) {
    throw createError({
      statusCode: 404,
      message: 'No billing history',
      data: { code: 'no_billing_history' },
    })
  }

  try {
    return await createPortalSession({
      apiKey,
      environment: config.public.paddleEnv,
      customerId: overview.paddleCustomerId,
      subscriptionIds: overview.cancellableSubscriptionIds,
    })
  } catch (error) {
    console.error(
      JSON.stringify({ kind: 'paddle_portal_failed', message: (error as Error).message }),
    )
    throw createError({
      statusCode: 502,
      message: 'Could not reach Paddle',
      data: { code: 'portal_failed' },
    })
  }
})
