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
import { isPass } from './billing'

/** The fields of an entitlement row this derivation reads. */
export interface BillingStateRow {
  /** The Paddle ref held in `paddle_subscription_id`: `sub_…`, `txn_…`, `comp_…`. */
  paddleSubscriptionId: string
  status: string
}

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
  const dunning = history.some(
    (row) => !isPass(row.paddleSubscriptionId) && row.status === 'past_due',
  )
  return dunning ? 'past_due' : 'inactive'
}
