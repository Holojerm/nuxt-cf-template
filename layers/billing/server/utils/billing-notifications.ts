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
import type { EmailContent } from '#server/utils/email-templates'
import { isUndeliverableAddress } from '#server/utils/users'
import { logEvent } from '#server/utils/log'

// ── The off switch ──────────────────────────────────────────────────────────
// `runtimeConfig.billing.notify` (applied at startup by registerBillingExtensions).
// An app that sends no customer email at all turns it off: every function below
// then returns before it looks up a user, builds a template or calls sendEmail,
// so nothing is sent, skipped-and-logged, or warned about. Default on.
let notifyEnabled = true

/** Turn the customer emails below on or off. Called once at startup. */
export function setBillingNotify(enabled: boolean): void {
  notifyEnabled = enabled
}

// Off by default. `billing.cancelOnDeletion` turns it on: the cancel it makes
// at Paddle is echoed by a `subscription.canceled` for an account that is now a
// tombstone (`deleted-<id>@deleted.invalid`), and "your access has ended" to an
// address that can never receive it is noise, so those recipients are skipped.
let skipUndeliverable = false

/** Skip notices to undeliverable (tombstone) addresses. Called once at startup. */
export function setSkipUndeliverableRecipients(enabled: boolean): void {
  skipUndeliverable = enabled
}

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

// ─── Comp grants and revokes ────────────────────────────────────────────────
// The admin console writes entitlements without a Paddle event, so it cannot go
// through decideNotification() above — there is no transition table entry for
// "a human decided". It still has to send, and for the same reason everything
// else here does: an entitlement changed under the customer.
//
// Silence was the old behaviour and it was worse than it sounds. A revoked comp
// derives to `inactive`, which renders the never-subscribed copy on /account —
// so a customer who had access yesterday saw a page implying they never had
// any, while the paid routes 402'd mid-session with no explanation anywhere.
//
// Both are best-effort, exactly like the webhook path: sendEmail never throws,
// and a mail outage must not fail the grant. The email is sent AFTER the write
// and awaited, so a customer is never told about access that did not land.

/** Shared plumbing: resolve the user, build, send. Never throws. */
async function sendToUser(
  db: Db,
  userId: string,
  build: (user: { name: string }) => EmailContent,
  kind: string,
): Promise<void> {
  if (!notifyEnabled) return
  try {
    const user = await findUserById(db, userId)
    if (!user) {
      logEvent('warn', 'billing_email_no_user', { userId, email: kind })
      return
    }
    await sendEmail({ to: user.email, ...build(user) })
  } catch (error) {
    logEvent('error', 'billing_email_failed', { userId, email: kind, error: String(error) })
  }
}

/** An admin granted comp access. Same email a purchased pass sends. */
export async function notifyCompGranted(
  db: Db,
  opts: { userId: string; endsAt: Date | null },
): Promise<void> {
  await sendToUser(
    db,
    opts.userId,
    (user) =>
      purchaseEmail(emailBranding(), { name: user.name, kind: 'pass', endsAt: opts.endsAt }),
    'comp_granted',
  )
}

/** An admin took comp access back. */
export async function notifyCompRevoked(db: Db, opts: { userId: string }): Promise<void> {
  await sendToUser(
    db,
    opts.userId,
    (user) => accessEndedEmail(emailBranding(), { name: user.name, reason: 'comp_revoked' }),
    'comp_revoked',
  )
}

/** Resolve the decision against a real user and actually send. Never throws. */
export async function notifyBillingOutcome(
  db: Db,
  outcome: PaddleEventOutcome,
  opts: { userId?: string; currentPeriodEnd?: Date | null } = {},
): Promise<void> {
  if (!notifyEnabled) return
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
      logEvent('warn', 'billing_email_no_user', { userId })
      return
    }
    if (skipUndeliverable && isUndeliverableAddress(user.email)) return

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
    logEvent('error', 'billing_email_failed', { userId, error: String(error) })
  }
}
