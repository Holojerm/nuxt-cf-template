// Turning a Paddle webhook outcome into at most one email.
//
// Split out of the webhook handler because the interesting logic isn't "send an
// email", it's "should this event produce one at all". Paddle emits a
// `subscription.updated` for a card change, a metadata tweak, a scheduled
// change being applied — most of which the customer neither caused nor cares
// about. Emailing per event teaches people to filter you into a folder, which
// is exactly where the payment-failed email must never land.
//
// So: email on TRANSITIONS, not on events.
//
//   nothing/past_due → active|trialing  → "your subscription is active"
//   active|trialing  → past_due         → "your payment did not go through"
//   anything         → canceled         → "your access has ended"
//   an approved refund or chargeback    → "your access has ended"
//   a one-time pass actually granted    → "your pass is active"
//
// Every other combination sends nothing. All of it is best-effort: sendEmail
// never throws, and a failure here must never make the webhook return non-200,
// because Paddle would replay the event forever.

import type { EntitlementDb as Db } from './entitlements'
import type { PaddleEventOutcome } from './entitlements'

/** Statuses that mean "the customer has access right now". */
const GRANTING = new Set(['active', 'trialing'])

type Decision =
  | { email: 'purchase'; kind: 'subscription' | 'pass'; endsAt: Date | null }
  | { email: 'payment_failed' }
  | { email: 'access_ended'; reason: 'canceled' | 'refunded' | 'chargeback' }
  | { email: 'none'; reason: string }

/**
 * Pure decision function — no DB, no network, so test/billing-notifications
 * can enumerate the transition table without mocking anything.
 */
export function decideNotification(
  outcome: PaddleEventOutcome,
  currentPeriodEnd: Date | null = null,
): Decision {
  if (outcome.kind === 'pass') {
    // `granted: false` is a webhook redelivery of a purchase we already handled.
    return outcome.granted
      ? { email: 'purchase', kind: 'pass', endsAt: outcome.endsAt }
      : { email: 'none', reason: 'redelivery' }
  }

  if (outcome.kind === 'subscription') {
    const was = outcome.previousStatus
    const now = outcome.status
    if (now === was) return { email: 'none', reason: 'no_status_change' }

    if (GRANTING.has(now) && !GRANTING.has(was ?? '')) {
      return { email: 'purchase', kind: 'subscription', endsAt: currentPeriodEnd }
    }
    if (now === 'past_due') return { email: 'payment_failed' }
    if (now === 'canceled') return { email: 'access_ended', reason: 'canceled' }
    return { email: 'none', reason: 'uninteresting_transition' }
  }

  if (outcome.kind === 'adjustment' && outcome.result.outcome === 'revoked') {
    return {
      email: 'access_ended',
      reason: outcome.action === 'chargeback' ? 'chargeback' : 'refunded',
    }
  }

  return { email: 'none', reason: 'no_email_for_outcome' }
}

/** Resolve the decision against a real user and actually send. Never throws. */
export async function notifyBillingOutcome(
  db: Db,
  outcome: PaddleEventOutcome,
  opts: { userId?: string; currentPeriodEnd?: Date | null } = {},
): Promise<void> {
  const decision = decideNotification(outcome, opts.currentPeriodEnd ?? null)
  if (decision.email === 'none') return

  const userId =
    opts.userId ??
    (outcome.kind === 'adjustment' ? outcome.result.userId : undefined) ??
    (outcome.kind === 'subscription' || outcome.kind === 'pass' ? outcome.userId : undefined)

  if (!userId) return

  try {
    const user = await findUserById(db, userId)
    if (!user) {
      console.warn(JSON.stringify({ kind: 'billing_email_no_user', userId }))
      return
    }

    const brand = emailBranding()
    const content =
      decision.email === 'purchase'
        ? purchaseEmail(brand, { name: user.name, kind: decision.kind, endsAt: decision.endsAt })
        : decision.email === 'payment_failed'
          ? paymentFailedEmail(brand, { name: user.name })
          : accessEndedEmail(brand, { name: user.name, reason: decision.reason })

    await sendEmail({ to: user.email, ...content })
  } catch (error) {
    // A broken email path must not turn into a 500 that makes Paddle replay a
    // money event. Log loudly, return quietly.
    console.error(JSON.stringify({ kind: 'billing_email_failed', userId, error: String(error) }))
  }
}
