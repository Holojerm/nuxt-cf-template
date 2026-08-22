// What is this account's billing state, in the one word the UI branches on?
//
// `active: false` is three different situations wearing the same face: never
// subscribed, subscription ended, and a payment that failed and is being
// retried. Only the last one has an action attached, and until this existed the
// product could not tell them apart — a customer in dunning saw "You don't have
// an active plan" and an invitation to buy the thing they were already paying
// for, while the one email about it sat unread.
//
// The `past_due` half is a claim about access, so it has to match
// server/utils/entitlements.ts exactly: ACTIVE_STATUSES is ['active',
// 'trialing'], `past_due` is deliberately not in it, and requireSubscription
// therefore 402s for the whole of dunning. Access really is paused, and the
// copy built on top of this says so. Don't soften the wording here without
// changing the gate — a UI that promises access the server denies is worse than
// no UI at all.
//
// Pure on purpose — no db, no h3 — so the matrix is a test
// (test/billing-state.test.ts) rather than a comment.

// Imported explicitly rather than through the Nitro auto-import: this file is
// pulled in by entitlement-view.ts, which the workerd vitest suite loads
// directly, and nothing is injected there.
import { isPass } from './paddle-refs'

/** The fields of an entitlement row this derivation reads. */
export interface BillingStateRow {
  /** The Paddle ref held in `paddle_subscription_id`: `sub_…`, `txn_…`, `comp_…`. */
  paddleSubscriptionId: string
  status: string
  /** Needed to tell live dunning from a `past_due` row nothing will ever clear. */
  currentPeriodEnd: Date | null
}

/**
 * How long after its period ended a `past_due` row still counts as dunning.
 *
 * ── Why a bound is necessary at all ──────────────────────────────────────────
 * A `sub_` row leaves `past_due` exactly one way: a delivered Paddle webhook.
 * There is no replay job and no reconciliation sweep in this template, so a
 * single dropped `subscription.updated` or `subscription.canceled` freezes the
 * row forever. Unbounded, `history.some(past_due)` then pins the account to a
 * state whose entire UI is "update your card to restore access" — for a
 * subscription Paddle cancelled months ago, that nothing the customer does can
 * clear, and which suppresses the re-subscribe path they actually need.
 *
 * ── Why 30 days ──────────────────────────────────────────────────────────────
 * Paddle's dunning schedule is configured in Paddle, not here, but the standard
 * retry sequence runs a few weeks before it gives up and cancels. 30 days is
 * comfortably past the far end of that, so a genuinely dunning subscription is
 * never cut short by this — the window only catches rows that stopped being
 * true and were never told. It is deliberately generous: showing "payment
 * failed" a week too long is a much smaller error than showing it forever.
 */
export const PAST_DUE_STALE_AFTER_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * - `active`   — a subscription or an unexpired pass is granting access.
 * - `trialing` — same, during a trial.
 * - `past_due` — a subscription's payment failed. No access; Paddle is retrying.
 * - `inactive` — nothing to fix: never bought, cancelled, refunded, or expired.
 */
export type BillingState = 'active' | 'trialing' | 'past_due' | 'inactive'

/**
 * @param granting the entitlement currently granting access (findActiveEntitlement), or null
 * @param history every entitlement row for the user, newest first
 */
export function deriveBillingState(
  granting: BillingStateRow | null,
  history: readonly BillingStateRow[],
  now: Date = new Date(),
): BillingState {
  // Whatever grants access wins, even over a past_due row sitting beside it. A
  // customer holding a live pass has NOT lost access, and telling them it's
  // paused is the same lie in the other direction. They see the dunning state
  // when the pass runs out — which is the moment it starts being true.
  if (granting) return granting.status === 'trialing' ? 'trialing' : 'active'

  // Only a subscription can be past_due. Everything else in this table expires
  // by date and has no lifecycle to fail: Paddle fires no events for a `txn_`
  // pass, and a `comp_` grant has no card behind it at all — telling someone to
  // update a payment method for access an admin handed them free would be an
  // invented problem.
  //
  // Asked through isPass() rather than a `sub_` prefix check of our own. That
  // rule already existed twice and had already drifted once (see billing.ts);
  // a third copy is how it drifts again the next time a ref shape is added.
  //
  // Bounded by PAST_DUE_STALE_AFTER_DAYS — see the constant for why an
  // unbounded scan is a trap. A row whose period ended long enough ago that
  // Paddle's dunning must have finished is reporting a retry that is not
  // happening, so it reads as `inactive` and the customer gets the
  // re-subscribe path instead of a card-update prompt for a dead subscription.
  //
  // A null period end cannot be judged stale, so it stays dunning: subscription
  // rows always carry a billing period, and guessing "expired" on a missing
  // date would suppress a real payment problem to tidy up an edge case.
  const staleBefore = new Date(now.getTime() - PAST_DUE_STALE_AFTER_DAYS * DAY_MS)
  const dunning = history.some(
    (row) =>
      !isPass(row.paddleSubscriptionId) &&
      row.status === 'past_due' &&
      (row.currentPeriodEnd === null || row.currentPeriodEnd > staleBefore),
  )
  return dunning ? 'past_due' : 'inactive'
}
