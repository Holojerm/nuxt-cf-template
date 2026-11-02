// Paddle webhook — POST /paddle/webhook
//
// Lives under server/routes/ (not /api/) so the global auth middleware never
// touches it: the HMAC signature IS the authentication. Configure the URL in
// Paddle → Developer tools → Notifications, subscribe to subscription.*,
// transaction.completed, adjustment.created and adjustment.updated, and put
// the endpoint's secret in NUXT_PADDLE_WEBHOOK_SECRET.
//
// Checkouts must carry custom_data.userId (usePaddle() does this) so purchases
// map back to a user. Refunds can't: adjustment events have no custom_data, so
// they're matched through the transaction/subscription id already on the row.
//
// This handler only authenticates, parses, and reports. What the event DOES to
// entitlements lives in ../../utils/entitlements.ts (applyPaddleEvent), which
// the workerd test suite drives directly. Anything else that should follow money
// arriving (the referral reward) registers a handler in
// ../../utils/billing-outcome.ts instead of being called from here.
//
// ── What raises an ops alert ─────────────────────────────────────────────────
// Every way this endpoint can drop or fail to apply a delivery that Paddle
// believes it made: unset secret (503), rejected signature (401), unreadable
// payload (400), and the four outcomes that grant nothing for a reason someone
// should look at: an adjustment matching no entitlement, an unknown user, no
// user at all, and an unrecognised price. Expected traffic (duplicates, stale
// and reordered events, another product's sale on a shared account) is a log
// line only. Paddle retries for days and tells nobody, so without these the
// failure mode is a paid customer who quietly never gets access.

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = config.paddle.webhookSecret
  if (!secret) {
    console.error(JSON.stringify({ kind: 'paddle_webhook_unconfigured' }))
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_unconfigured',
      detail: 'NUXT_PADDLE_WEBHOOK_SECRET is unset — every billing event is being dropped',
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 503, message: 'Webhook not configured' })
  }

  // Raw body BEFORE any parsing — the signature covers the exact bytes.
  const rawBody = await readRawBody(event)
  const signature = getRequestHeader(event, 'paddle-signature')
  const check = await verifyPaddleSignature(rawBody ?? '', signature, secret)
  if (!check.valid) {
    console.warn(JSON.stringify({ kind: 'paddle_webhook_rejected', reason: check.reason }))
    // Worth an alert even though most of these will be internet noise: if the
    // endpoint secret ever drifts from Paddle's, this is the only symptom, and
    // the failure mode is silent.
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_rejected',
      detail: `signature rejected: ${check.reason}`,
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 401, message: 'Invalid signature' })
  }

  // A signed body that is not JSON is the same refusal as one that is not a
  // Paddle event: 400, not the 500 an unguarded JSON.parse would throw (and a
  // 500 makes Paddle retry it, and a spooled "server error" ops event, for a
  // payload no retry can fix).
  let json: unknown
  let readable = true
  try {
    json = JSON.parse(rawBody ?? '{}')
  } catch {
    readable = false
  }
  const parsed = readable ? paddleEventSchema.safeParse(json) : null
  if (!parsed?.success) {
    console.warn(JSON.stringify({ kind: 'paddle_webhook_unparseable' }))
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_unparseable',
      detail: readable
        ? 'payload did not match paddleEventSchema — Paddle may have changed shape'
        : 'payload was not valid JSON',
      path: pathForLog(event.path),
    })
    throw createError({ statusCode: 400, message: 'Unrecognized payload' })
  }
  const paddleEvent = parsed.data
  const eventType = paddleEvent.event_type

  const outcome = await applyPaddleEvent(db, paddleEvent, paddlePriceCatalogue(config.public))

  // At most one email, only on a real transition — see
  // layers/billing/server/utils/billing-notifications.ts for the decision table. Awaited so it
  // survives the isolate being torn down, and never throwing so a mail outage
  // can't make Paddle replay a money event.
  await notifyBillingOutcome(db, outcome, {
    currentPeriodEnd: paddleEvent.data.current_billing_period
      ? new Date(paddleEvent.data.current_billing_period.ends_at)
      : null,
  })

  // Whatever else cares what the event did: the referral reward and its
  // clawback paperwork are the shipped handlers (server/plugins/referral.ts in
  // core). Awaited, in registration order, and never throwing, for the same
  // reason as the email above.
  await runBillingOutcomeHandlers({ db, event: paddleEvent, outcome })

  if (outcome.kind === 'subscription') {
    await captureServerEvent({
      distinctId: outcome.userId,
      event: paddleSubscriptionEvent(eventType),
      properties: { subscriptionId: paddleEvent.data.id, status: outcome.status },
    })
  } else if (outcome.kind === 'pass') {
    await captureServerEvent({
      distinctId: outcome.userId,
      event: 'paddle_transaction_completed',
      properties: {
        transactionId: paddleEvent.data.id,
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
    console.warn(
      JSON.stringify({
        kind: 'paddle_adjustment',
        eventType,
        action: outcome.action,
        adjustmentType: paddleEvent.data.type,
        status: paddleEvent.data.status,
        transactionId: paddleEvent.data.transaction_id,
        outcome: outcome.result.outcome,
        // How many derived rows (referral rewards) moved with it. Zero is the
        // ordinary case — most purchases were nobody's referral — but without
        // it a clawback that found nothing is indistinguishable from one that
        // was never attempted.
        derived: outcome.result.derived?.length ?? 0,
      }),
    )
    // The outcome, not the absence of a userId: a reversal legitimately carries
    // no userId, so keying on that filed a false "we have no such entitlement"
    // for every dispute the merchant WON. Off for an app that shares its Paddle
    // account with another (billing.alertUnmatchedAdjustments): adjustments
    // carry no product, so it cannot tell the other app's refunds from its own.
    if (config.billing.alertUnmatchedAdjustments && adjustmentMatchedNothing(outcome.result)) {
      await recordOpsEvent(db, {
        kind: 'paddle_adjustment_unmatched',
        detail: `${outcome.action} for ${paddleEvent.data.transaction_id ?? 'unknown txn'} matched no entitlement`,
        path: pathForLog(event.path),
      })
    }
    if (outcome.result.userId) {
      await captureServerEvent({
        distinctId: outcome.result.userId,
        event: 'paddle_access_revoked',
        properties: {
          reason: outcome.action,
          paddleRef: outcome.result.paddleRef,
          adjustmentType: paddleEvent.data.type,
        },
      })
    }
  } else if (outcome.reason === 'unknown_user' && isUnknownUserExpected(paddleEvent)) {
    // The app said this is expected (registerUnknownUserExpectation: e.g. the
    // echo of its own cancel-then-delete). Acknowledged, logged, not alerted.
    console.info(
      JSON.stringify({ kind: 'paddle_webhook_after_deletion', eventType, id: paddleEvent.data.id }),
    )
  } else if (outcome.reason === 'unknown_user') {
    // custom_data.userId names no account. Acknowledged (a 500 on the foreign
    // key would have Paddle retry forever), but alerted: money arriving for an
    // account that does not exist is what a hard-deleted customer looks like.
    console.warn(
      JSON.stringify({ kind: 'paddle_webhook_unknown_user', eventType, id: paddleEvent.data.id }),
    )
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_unknown_user',
      detail: `${eventType} for ${paddleEvent.data.id} names an account that does not exist — nothing granted`,
      path: pathForLog(event.path),
    })
  } else if (outcome.reason === 'no_user') {
    console.warn(
      JSON.stringify({ kind: 'paddle_webhook_no_user', eventType, id: paddleEvent.data.id }),
    )
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_no_user',
      detail: `${eventType} for ${paddleEvent.data.id} carried no userId — purchase not granted`,
      path: pathForLog(event.path),
    })
  } else if (
    outcome.reason === 'duplicate_event' ||
    outcome.reason === 'stale_event' ||
    outcome.reason === 'terminal_status'
  ) {
    console.warn(
      JSON.stringify({
        kind: 'paddle_webhook_not_applied',
        reason: outcome.reason,
        eventType,
        eventId: paddleEvent.event_id,
        id: paddleEvent.data.id,
      }),
    )
  } else if (
    outcome.reason === 'unrecognised_price' &&
    outcome.detail === 'unknown_price' &&
    isForeignProduct(paddleEvent.data.items, config.paddle.productId)
  ) {
    // Another app's sale on a shared Paddle account (NUXT_PADDLE_PRODUCT_ID
    // names ours): nothing to fix here, and it granted nothing.
    console.info(
      JSON.stringify({
        kind: 'paddle_webhook_foreign_product',
        eventType,
        id: paddleEvent.data.id,
        priceIds: outcome.priceIds,
      }),
    )
  } else if (outcome.reason === 'unrecognised_price') {
    // Acknowledged (200) so Paddle stops retrying, but loud: either a price
    // was added in the dashboard without a NUXT_PUBLIC_PADDLE_PRICE_* entry, or
    // someone opened a checkout for something the app does not sell.
    console.warn(
      JSON.stringify({
        kind: 'paddle_webhook_unrecognised_price',
        eventType,
        id: paddleEvent.data.id,
        detail: outcome.detail,
        priceIds: outcome.priceIds,
      }),
    )
    await recordOpsEvent(db, {
      kind: 'paddle_webhook_unrecognised_price',
      detail: `${eventType} for ${paddleEvent.data.id} (${outcome.detail}: ${outcome.priceIds.join(', ') || 'no items'}) — nothing granted`,
      path: pathForLog(event.path),
    })
  }
  // Unhandled event types are acknowledged so Paddle doesn't retry them.

  return { received: true }
})
