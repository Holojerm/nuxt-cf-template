// The referral loop's side of the Paddle webhook: pay the referrer when the
// referee first pays, and record the clawback's paperwork when a refund or
// chargeback reverses a purchase. Registered as a billing outcome handler by
// server/plugins/referral.ts through core's seam (server/utils/billing-outcome.ts),
// so the billing layer's webhook never imports referral, this file never
// imports billing, and an app without either simply registers nothing.
//
// Moved verbatim from the webhook route; the reasoning below was written for
// that call site and holds here unchanged.

import type { BillingOutcomeContext } from './billing-outcome'
import { recordReferralCascade, rewardReferrerForFirstPurchase } from './referral'

export interface ReferralOutcomeDeps {
  reward: typeof rewardReferrerForFirstPurchase
  cascade: typeof recordReferralCascade
}

export function createReferralOutcomeHandler(
  deps: ReferralOutcomeDeps = {
    reward: rewardReferrerForFirstPurchase,
    cascade: recordReferralCascade,
  },
) {
  return async function referralOutcomeHandler({
    db,
    event,
    outcome,
  }: BillingOutcomeContext): Promise<void> {
    // ── The referrer's half of the referral loop ─────────────────────────────
    // The webhook is the closest the app gets to observing money arrive, which
    // is why the referrer is paid from here and not at signup: a reward
    // triggered by account creation costs an attacker one fresh mailbox.
    //
    // Called on every qualifying event rather than on a detected "first"
    // purchase — the reward's ref is derived from the referee's id, so the
    // unique index makes a redelivery a repair rather than a second payout, and
    // a customer's second pass pays nothing. Awaited so the isolate cannot be
    // torn down mid-write, and it never throws, because a 500 here makes Paddle
    // replay a money event.
    //
    // ── What "first paid" actually means, and what it does not ───────────────
    // For a pass, `kind: 'pass'` IS a `transaction.completed` — money landed.
    //
    // For a subscription it is a STATUS TRANSITION, not a payment: the first
    // time this app sees the subscription (`previousStatus === null`) or the
    // moment a trial converts. Those two are the only transitions that can be a
    // first payment. Everything else is excluded on purpose — `past_due →
    // active` is a dunning recovery on a subscription that already paid,
    // `paused → active` is a resume, and `trialing` itself is not money.
    //
    // It is deliberately NOT keyed on `transaction.completed` carrying a
    // `subscription_id`, which would be the truer signal. applyPaddleEvent
    // classifies that as `ignored: 'subscription_transaction'` and returns no
    // userId, so using it would mean widening that contract AND relying on
    // Paddle to echo the checkout's `custom_data` onto subscription
    // transactions — which is not something this template can verify. Getting
    // that wrong pays no subscription referrer at all, silently, which is worse
    // than the residue below.
    //
    // The residue: a subscription created `active` under manual collection
    // before its invoice is paid, or one carrying a 100% discount, pays a
    // referrer for a sale worth nothing. Neither is distinguishable from a
    // status, and neither survives contact with the clawback — an unpaid
    // invoice ends in a cancellation and a discounted one that is refunded
    // revokes below.
    const firstSubscriptionPayment =
      outcome.kind === 'subscription' &&
      outcome.status === 'active' &&
      (outcome.previousStatus === null || outcome.previousStatus === 'trialing')

    if (outcome.kind === 'pass' || firstSubscriptionPayment) {
      // The ref a later refund will name: the transaction id for a pass, and for
      // a subscription its FIRST transaction — so a refund of a later renewal
      // finds no reward to claw back. Falls back to the subscription id when
      // Paddle never sent one. Without a ref the reward is unreachable by any
      // clawback.
      await deps.reward(db, outcome.userId, {
        earnedFromRef:
          outcome.kind === 'subscription'
            ? (outcome.firstTransactionId ?? event.data.id)
            : event.data.id,
      })
    }

    // ── …and the paperwork for the clawback ──────────────────────────────────
    // The clawback ITSELF is not here. It happens inside revokeForAdjustment
    // (the billing layer's entitlements.ts), keyed on the purchase via
    // `earned_from_ref`, so every caller of that function gets it rather than
    // just the webhook — including the reversal that puts a reward back when a
    // chargeback is won. All that is left is recording what it did, which is
    // deliberately the caller's job so the money path cannot fail on an audit
    // write. Never throws.
    if (outcome.kind === 'adjustment') {
      await deps.cascade(db, outcome.result)
    }
  }
}
