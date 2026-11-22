// Start a purchase: create a Stripe hosted Checkout Session for the signed-in
// user and return its URL. The pricing page sends the browser there; Stripe
// sends it back to /pricing with `?checkout=success` or `?checkout=canceled`.
//
// The body names a PLAN, never a price: the price id comes from this server's
// config, and the account from the session, so nothing the browser sends can
// change what is sold or who it is for. The redirect back grants nothing either:
// access arrives with the webhook (layers/billing/server/routes/stripe/webhook.post.ts).
//
// Sold through Stripe Managed Payments, which exists only on hosted Checkout.

import { z } from 'zod'

const bodySchema = z.object({ plan: z.enum(['monthly', 'pass']) })

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const { plan } = await readValidatedBody(event, bodySchema.parse)
  const config = useRuntimeConfig(event)

  const secretKey = config.stripe.secretKey
  const price = priceForPlan(config.public, plan)
  if (!secretKey || !price) {
    logEvent('error', 'stripe_checkout_unconfigured', { plan, key: Boolean(secretKey) })
    throw createError({
      statusCode: 503,
      message: 'Checkout not configured',
      data: { code: 'checkout_unconfigured' },
    })
  }

  // Reuse the Stripe customer a returning buyer already has, so the portal
  // shows one history. A first purchase is matched by email instead.
  const overview = await getBillingOverview(db, user.id)
  const origin = getRequestURL(event).origin

  try {
    const session = await createCheckoutSession({
      secretKey,
      apiBase: config.stripe.apiBase,
      mode: price.kind === 'subscription' ? 'subscription' : 'payment',
      priceId: price.priceId,
      userId: user.id,
      customerId: overview.providerCustomerId,
      customerEmail: user.email,
      successUrl: `${origin}/pricing?checkout=success`,
      cancelUrl: `${origin}/pricing?checkout=canceled`,
    })
    return { url: session.url }
  } catch (error) {
    const stripe = error instanceof StripeApiError ? error : null
    logEvent('error', 'stripe_checkout_failed', {
      plan,
      status: stripe?.status ?? 0,
      code: stripe?.code ?? null,
    })
    throw createError({
      statusCode: 502,
      message: 'Could not reach Stripe',
      data: { code: 'checkout_failed' },
    })
  }
})
