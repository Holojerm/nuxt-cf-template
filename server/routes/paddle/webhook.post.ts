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
// entitlements lives in server/utils/entitlements.ts (applyPaddleEvent), which
// the workerd test suite drives directly.

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

  const parsed = paddleEventSchema.safeParse(JSON.parse(rawBody ?? '{}'))
  if (!parsed.success) {
    console.warn(JSON.stringify({ kind: 'paddle_webhook_unparseable' }))
    throw createError({ statusCode: 400, message: 'Unrecognized payload' })
  }
  const paddleEvent = parsed.data
  const eventType = paddleEvent.event_type

  const outcome = await applyPaddleEvent(db, paddleEvent)

  // At most one email, only on a real transition — see
  // server/utils/billing-notifications.ts for the decision table. Awaited so it
  // survives the isolate being torn down, and never throwing so a mail outage
  // can't make Paddle replay a money event.
  await notifyBillingOutcome(db, outcome, {
    currentPeriodEnd: paddleEvent.data.current_billing_period
      ? new Date(paddleEvent.data.current_billing_period.ends_at)
      : null,
  })

  // ── The referrer's half of the referral loop ───────────────────────────────
  // This handler is the closest the app gets to observing money arrive, which
  // is why the referrer is paid from here and not at signup: a reward triggered
  // by account creation costs an attacker one fresh mailbox.
  //
  // Called on every qualifying event rather than on a detected "first" purchase
  // — the reward's ref is derived from the referee's id, so the unique index
  // makes a redelivery a repair rather than a second payout, and a customer's
  // second pass pays nothing. Same contract as notifyBillingOutcome above:
  // awaited so the isolate cannot be torn down mid-write, and it never throws,
  // because a 500 here makes Paddle replay a money event.
  //
  // ── What "first paid" actually means, and what it does not ─────────────────
  // For a pass, `kind: 'pass'` IS a `transaction.completed` — money landed.
  //
  // For a subscription it is a STATUS TRANSITION, not a payment: the first time
  // this app sees the subscription (`previousStatus === null`) or the moment a
  // trial converts. Those two are the only transitions that can be a first
  // payment. Everything else is excluded on purpose — `past_due → active` is a
  // dunning recovery on a subscription that already paid, `paused → active` is
  // a resume, and `trialing` itself is not money.
  //
  // It is deliberately NOT keyed on `transaction.completed` carrying a
  // `subscription_id`, which would be the truer signal. applyPaddleEvent
  // classifies that as `ignored: 'subscription_transaction'` and returns no
  // userId, so using it would mean widening that contract AND relying on Paddle
  // to echo the checkout's `custom_data` onto subscription transactions — which
  // is not something this template can verify. Getting that wrong pays no
  // subscription referrer at all, silently, which is worse than the residue
  // below.
  //
  // The residue: a subscription created `active` under manual collection before
  // its invoice is paid, or one carrying a 100% discount, pays a referrer for
  // a sale worth nothing. Neither is distinguishable from a status, and neither
  // survives contact with the clawback — an unpaid invoice ends in a
  // cancellation and a discounted one that is refunded revokes below.
  const firstSubscriptionPayment =
    outcome.kind === 'subscription' &&
    outcome.status === 'active' &&
    (outcome.previousStatus === null || outcome.previousStatus === 'trialing')

  if (outcome.kind === 'pass' || firstSubscriptionPayment) {
    // `data.id` is the ref of the entitlement row this purchase created — the
    // transaction id for a pass, the subscription id for a subscription — and
    // therefore exactly what a later adjustment will match on. Stored on the
    // reward so a refund of THIS purchase can find it. Without it the reward
    // is unreachable by any clawback.
    await rewardReferrerForFirstPurchase(db, outcome.userId, {
      earnedFromRef: paddleEvent.data.id,
    })
  }

  // ── …and the paperwork for the clawback ────────────────────────────────────
  // The clawback ITSELF is not here any more. It happens inside
  // revokeForAdjustment (server/utils/entitlements.ts), keyed on the purchase
  // via `earned_from_ref`, so every caller of that function gets it rather than
  // just this route — including the reversal that puts a reward back when a
  // chargeback is won. All that is left here is recording what it did, which is
  // deliberately the caller's job so the money path cannot fail on an audit
  // write. Never throws.
  if (outcome.kind === 'adjustment') {
    await recordReferralCascade(db, outcome.result)
  }

  if (outcome.kind === 'subscription') {
    await captureServerEvent({
      distinctId: outcome.userId,
      event: `paddle_${eventType.replace('.', '_')}`,
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
  } else if (outcome.reason === 'no_user') {
    console.warn(
      JSON.stringify({ kind: 'paddle_webhook_no_user', eventType, id: paddleEvent.data.id }),
    )
  }
  // Unhandled event types are acknowledged so Paddle doesn't retry them.

  return { received: true }
})
