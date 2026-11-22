// Stripe webhook: POST /stripe/webhook
//
// Lives under server/routes/ (not /api/) so the global auth middleware never
// touches it: the HMAC signature IS the authentication. Add the endpoint in
// Stripe (Developers › Webhooks) on API version STRIPE_API_VERSION
// (layers/billing/server/utils/stripe-api.ts), subscribe it to
// customer.subscription.created, .updated, .deleted, .paused and .resumed,
// checkout.session.completed, checkout.session.async_payment_succeeded,
// charge.refunded, charge.dispute.created, charge.dispute.closed and
// charge.dispute.funds_reinstated, and put its signing secret in
// NUXT_STRIPE_WEBHOOK_SECRET.
//
// The checkout route (layers/billing/server/api/billing/checkout.post.ts) stamps
// the account on the session, the subscription and the payment as
// `metadata.userId`, so purchases map back to a user. Refunds and disputes name
// only a charge, so they are matched through the invoice or payment id already
// on the row.
//
// This handler authenticates, translates Stripe's payload into the layer's own
// event (layers/billing/server/utils/stripe-events.ts) and reports. What the
// event DOES to entitlements lives in layers/billing/server/utils/entitlements.ts
// (applyBillingEvent), which the workerd test suite drives directly. Anything
// else that should follow money arriving (the referral reward) registers a
// handler in core's server/utils/billing-outcome.ts instead of being called
// from here.
//
// ── What raises an ops alert ─────────────────────────────────────────────────
// Every way this endpoint can drop or fail to apply a delivery that Stripe
// believes it made: unset secret or key (503), rejected signature (401),
// unreadable payload (400), a Stripe lookup that failed (502), and the four
// outcomes that grant nothing for a reason someone should look at: an
// adjustment matching no entitlement, an unknown user, no user at all, and an
// unrecognised price. Expected traffic (duplicates, stale and reordered events,
// another product's sale on a shared account) is a log line only. Stripe retries
// for days and tells nobody, so without these the failure mode is a paid
// customer who quietly never gets access.

import type { BillingEvent } from '../../utils/entitlements'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = config.stripe.webhookSecret
  const secretKey = config.stripe.secretKey
  // The key is as load-bearing as the secret: a pass purchase and every refund
  // need a lookup at Stripe before they can be applied.
  if (!secret || !secretKey) {
    logEvent('error', 'stripe_webhook_unconfigured')
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_unconfigured',
      detail: `${secret ? 'NUXT_STRIPE_SECRET_KEY' : 'NUXT_STRIPE_WEBHOOK_SECRET'} is unset: every billing event is being dropped`,
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 503, message: 'Webhook not configured' })
  }

  // Raw body BEFORE any parsing — the signature covers the exact bytes.
  const rawBody = await readRawBody(event)
  const signature = getRequestHeader(event, 'stripe-signature')
  const check = await verifyStripeSignature(rawBody ?? '', signature, secret)
  if (!check.valid) {
    logEvent('warn', 'stripe_webhook_rejected', { reason: check.reason })
    // Worth an alert even though most of these will be internet noise: if the
    // endpoint secret ever drifts from Stripe's, this is the only symptom, and
    // the failure mode is silent.
    await recordUnauthenticatedOpsEvent(db, {
      kind: 'stripe_webhook_rejected',
      detail: `signature rejected: ${check.reason}`,
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 401, message: 'Invalid signature' })
  }

  // A signed body that is not JSON is the same refusal as one that is not a
  // Stripe event: 400, not the 500 an unguarded JSON.parse would throw (and a
  // 500 makes Stripe retry it, and a spooled "server error" ops event, for a
  // payload no retry can fix).
  let json: unknown
  let readable = true
  try {
    json = JSON.parse(rawBody ?? '{}')
  } catch {
    readable = false
  }
  const parsed = readable ? stripeEventSchema.safeParse(json) : null
  const unparseable = async (detail: string) => {
    logEvent('warn', 'stripe_webhook_unparseable')
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_unparseable',
      detail,
      path: pathForLog(event.path),
    })
    return createError({ statusCode: 400, message: 'Unrecognized payload' })
  }
  if (!parsed?.success) {
    throw await unparseable(
      readable
        ? 'payload did not match stripeEventSchema: Stripe may have changed shape'
        : 'payload was not valid JSON',
    )
  }

  const client = { secretKey, apiBase: config.stripe.apiBase }
  let billingEvent: BillingEvent | null
  try {
    billingEvent = await normalizeStripeEvent(parsed.data, {
      lineItems: (sessionId) => listCheckoutLineItems({ ...client, sessionId }),
      paymentRefs: (paymentIntentId) => findPaymentRefs({ ...client, paymentIntentId }),
    })
  } catch (error) {
    if (error instanceof StripeEventShapeError) {
      throw await unparseable(
        `${error.eventType} did not have the expected shape: check the endpoint's API version`,
      )
    }
    // A lookup at Stripe failed. Nothing was written, so a 5xx is right: Stripe
    // redelivers, and the next attempt asks again.
    const reason =
      error instanceof StripeApiError
        ? `status ${error.status}, code ${error.code ?? 'none'}`
        : 'error outside the Stripe response'
    logEvent('error', 'stripe_webhook_lookup_failed', { eventType: parsed.data.type, reason })
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_lookup_failed',
      detail: `${parsed.data.type} ${parsed.data.id}: ${reason}. Not applied; Stripe will redeliver`,
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 502, message: 'Could not reach Stripe' })
  }
  // An event type the layer does not act on, or a subscription whose first
  // payment never completed: acknowledged so Stripe doesn't retry it.
  if (!billingEvent) return { received: true }
  const eventType = billingEvent.event_type

  // The layer's own `billing_*` PostHog events. An app that records its own plan
  // events through registerBillingOutcomeHandler() turns these off
  // (billing.analytics); only an explicit false does, so a config without the key
  // keeps sending.
  const capture: typeof captureServerEvent =
    config.billing.analytics === false ? async () => {} : captureServerEvent

  const outcome = await applyBillingEvent(db, billingEvent, priceCatalogue(config.public))

  // At most one email, only on a real transition — see
  // layers/billing/server/utils/billing-notifications.ts for the decision table. Awaited so it
  // survives the isolate being torn down, and never throwing so a mail outage
  // can't make Stripe replay a money event.
  await notifyBillingOutcome(db, outcome, {
    currentPeriodEnd: billingEvent.data.current_billing_period
      ? new Date(billingEvent.data.current_billing_period.ends_at)
      : null,
  })

  // Whatever else cares what the event did: the referral reward and its
  // clawback paperwork are the shipped handlers (server/plugins/referral.ts).
  // Core's registry (server/utils/billing-outcome.ts), so no feature imports
  // billing and billing imports none. Awaited, in registration order, and never throwing, for the same
  // reason as the email above.
  await runBillingOutcomeHandlers({ db, event: billingEvent, outcome })

  if (outcome.kind === 'subscription') {
    await capture({
      distinctId: outcome.userId,
      event: billingSubscriptionEvent(eventType),
      properties: { subscriptionId: billingEvent.data.id, status: outcome.status },
    })
  } else if (outcome.kind === 'pass') {
    await capture({
      distinctId: outcome.userId,
      event: 'billing_transaction_completed',
      properties: {
        transactionId: billingEvent.data.id,
        pass: true,
        granted: outcome.granted,
        stacked: Boolean(outcome.stackedOn),
        endsAt: outcome.endsAt.toISOString(),
      },
    })
  } else if (outcome.kind === 'adjustment') {
    // Money going back out is worth a log line even when nothing matched —
    // "refund arrived for an entitlement we don't have" is exactly the kind of
    // silent drift that turns into a support email.
    logEvent('warn', 'billing_adjustment', {
      eventType,
      action: outcome.action,
      adjustmentType: billingEvent.data.type,
      status: billingEvent.data.status,
      transactionId: billingEvent.data.transaction_id,
      outcome: outcome.result.outcome,
      // Zero is ordinary (most purchases were nobody's referral); without it a
      // clawback that found nothing looks like one never attempted.
      derived: outcome.result.derived?.length ?? 0,
    })
    // The outcome, not the absence of a userId: a reversal legitimately carries
    // no userId, so keying on that filed a false "we have no such entitlement"
    // for every dispute the merchant WON. Off for an app that shares its Stripe
    // account with another (billing.alertUnmatchedAdjustments): adjustments
    // carry no product, so it cannot tell the other app's refunds from its own.
    if (config.billing.alertUnmatchedAdjustments && adjustmentMatchedNothing(outcome.result)) {
      await recordOpsEvent(db, {
        kind: 'stripe_adjustment_unmatched',
        detail: `${outcome.action} for ${billingEvent.data.transaction_id ?? 'unknown txn'} matched no entitlement`,
        path: pathForLog(event.path),
      })
    }
    if (outcome.result.userId) {
      await capture({
        distinctId: outcome.result.userId,
        event: 'billing_access_revoked',
        properties: {
          reason: outcome.action,
          billingRef: outcome.result.billingRef,
          adjustmentType: billingEvent.data.type,
        },
      })
    }
  } else if (outcome.reason === 'unknown_user' && isUnknownUserExpected(billingEvent)) {
    // The app said this is expected (registerUnknownUserExpectation: e.g. the
    // echo of its own cancel-then-delete). Acknowledged, logged, not alerted.
    logEvent('info', 'stripe_webhook_after_deletion', { eventType, id: billingEvent.data.id })
  } else if (outcome.reason === 'unknown_user') {
    // custom_data.userId names no account. Acknowledged (a 500 on the foreign
    // key would have Stripe retry forever), but alerted: money arriving for an
    // account that does not exist is what a hard-deleted customer looks like.
    logEvent('warn', 'stripe_webhook_unknown_user', { eventType, id: billingEvent.data.id })
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_unknown_user',
      detail: `${eventType} for ${billingEvent.data.id} names an account that does not exist — nothing granted`,
      path: pathForLog(event.path),
    })
  } else if (outcome.reason === 'no_user') {
    logEvent('warn', 'stripe_webhook_no_user', { eventType, id: billingEvent.data.id })
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_no_user',
      detail: `${eventType} for ${billingEvent.data.id} carried no userId — purchase not granted`,
      path: pathForLog(event.path),
    })
  } else if (
    outcome.reason === 'duplicate_event' ||
    outcome.reason === 'stale_event' ||
    outcome.reason === 'terminal_status'
  ) {
    logEvent('warn', 'stripe_webhook_not_applied', {
      reason: outcome.reason,
      eventType,
      eventId: billingEvent.event_id,
      id: billingEvent.data.id,
    })
  } else if (
    outcome.reason === 'unrecognised_price' &&
    outcome.detail === 'unknown_price' &&
    isForeignProduct(billingEvent.data.items, config.stripe.productId)
  ) {
    // Another app's sale on a shared Stripe account (NUXT_STRIPE_PRODUCT_ID
    // names ours): nothing to fix here, and it granted nothing.
    logEvent('info', 'stripe_webhook_foreign_product', {
      eventType,
      id: billingEvent.data.id,
      priceIds: outcome.priceIds,
    })
  } else if (outcome.reason === 'unrecognised_price') {
    // Acknowledged (200) so Stripe stops retrying, but loud: either a price
    // was added in the dashboard without a NUXT_PUBLIC_STRIPE_PRICE_* entry, or
    // someone opened a checkout for something the app does not sell.
    logEvent('warn', 'stripe_webhook_unrecognised_price', {
      eventType,
      id: billingEvent.data.id,
      detail: outcome.detail,
      priceIds: outcome.priceIds,
    })
    await recordOpsEvent(db, {
      kind: 'stripe_webhook_unrecognised_price',
      detail: `${eventType} for ${billingEvent.data.id} (${outcome.detail}: ${outcome.priceIds.join(', ') || 'no items'}) — nothing granted`,
      path: pathForLog(event.path),
    })
  }
  // Unhandled event types are acknowledged so Stripe doesn't retry them.

  return { received: true }
})
