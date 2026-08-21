// Paddle webhook — POST /paddle/webhook
//
// Lives under server/routes/ (not /api/) so the global auth middleware never
// touches it: the HMAC signature IS the authentication. Configure the URL in
// Paddle → Developer tools → Notifications, subscribe to subscription.* and
// transaction.completed, and put the endpoint's secret in
// NUXT_PADDLE_WEBHOOK_SECRET.
//
// Subscriptions must be created with custom_data.userId (usePaddle() does this
// at checkout) so events can be mapped back to a user.

import { z } from 'zod'

const eventSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    status: z.string().optional(),
    customer_id: z.string().nullish(),
    custom_data: z
      .object({ userId: z.string().optional(), productKey: z.string().optional() })
      .nullish(),
    current_billing_period: z.object({ ends_at: z.string() }).nullish(),
  }),
})

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const secret = config.paddle.webhookSecret
  if (!secret) {
    console.error(JSON.stringify({ kind: 'paddle_webhook_unconfigured' }))
    throw createError({ statusCode: 503, message: 'Webhook not configured' })
  }

  // Raw body BEFORE any parsing — the signature covers the exact bytes.
  const rawBody = await readRawBody(event)
  const signature = getRequestHeader(event, 'paddle-signature')
  const check = await verifyPaddleSignature(rawBody ?? '', signature, secret)
  if (!check.valid) {
    console.warn(JSON.stringify({ kind: 'paddle_webhook_rejected', reason: check.reason }))
    throw createError({ statusCode: 401, message: 'Invalid signature' })
  }

  const parsed = eventSchema.safeParse(JSON.parse(rawBody ?? '{}'))
  if (!parsed.success) {
    console.warn(JSON.stringify({ kind: 'paddle_webhook_unparseable' }))
    throw createError({ statusCode: 400, message: 'Unrecognized payload' })
  }
  const { event_type: eventType, data } = parsed.data

  // All subscription.* lifecycle events carry the full subscription entity —
  // one upsert keyed on the subscription id keeps the entitlement current.
  if (eventType.startsWith('subscription.')) {
    const userId = data.custom_data?.userId
    if (!userId) {
      // Not fatal: a subscription created outside the app (e.g. dashboard test)
      console.warn(JSON.stringify({ kind: 'paddle_webhook_no_user', subscriptionId: data.id }))
      return { received: true }
    }
    const entitlement = {
      userId,
      paddleCustomerId: data.customer_id ?? null,
      paddleSubscriptionId: data.id,
      productKey: data.custom_data?.productKey ?? 'default',
      status: data.status ?? 'unknown',
      currentPeriodEnd: data.current_billing_period
        ? new Date(data.current_billing_period.ends_at)
        : null,
    }
    await db
      .insert(schema.entitlements)
      .values(entitlement)
      .onConflictDoUpdate({
        target: schema.entitlements.paddleSubscriptionId,
        set: {
          status: entitlement.status,
          currentPeriodEnd: entitlement.currentPeriodEnd,
          paddleCustomerId: entitlement.paddleCustomerId,
          updatedAt: new Date(),
        },
      })
    await captureServerEvent({
      distinctId: userId,
      event: `paddle_${eventType.replace('.', '_')}`,
      properties: { subscriptionId: data.id, status: entitlement.status },
    })
  } else if (eventType === 'transaction.completed') {
    const userId = data.custom_data?.userId
    if (userId) {
      await captureServerEvent({
        distinctId: userId,
        event: 'paddle_transaction_completed',
        properties: { transactionId: data.id },
      })
    }
  }
  // Unhandled event types are acknowledged so Paddle doesn't retry them.

  return { received: true }
})
