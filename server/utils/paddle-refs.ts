// What the ref in `entitlements.paddle_subscription_id` means.
//
// One column holds three shapes, and the prefix decides how the row behaves:
//
//   `sub_…`   an auto-renewing Paddle subscription. Paddle owns its lifecycle
//             and flips the status when it ends, so it grants access on STATUS
//             ALONE — findActiveEntitlement does not check its date.
//   `txn_…`   a purchased one-time pass. No lifecycle event ever fires for it,
//             so it grants access only while current_period_end is in future.
//   `comp_…`  the same, granted by an admin instead of sold.
//   `referral_…`  earned access: the referrer's reward, keyed by the referee.
//   `welcome_…`   earned access: the referee's arrival bonus, keyed by them.
//
// ── Why this is its own leaf module ──────────────────────────────────────────
// This rule is read by the access query (entitlements.ts), the state derivation
// (billing-state.ts), the customer's view (entitlement-view.ts), and the comp
// lifecycle (admin-grants.ts). It has already drifted once: `isPass` was keyed
// on the presence of `txn_` while the access query keyed on the absence of
// `sub_`, which made a comped month read as a subscription on /account.
//
// A leaf with no imports of its own is what keeps the fix from un-drifting. It
// also breaks a cycle that was forming: entitlements.ts needs the predicate,
// billing.ts (where it used to live) reaches back into entitlements.ts at
// runtime, and the next person to add a static import there would have closed
// the loop.
//
// Nitro auto-imports every name here Nitro-wide, so most call sites need no
// import at all. Files the workerd vitest suite loads directly must import
// explicitly — nothing is injected there.

/** Auto-renewing subscription: status-driven, date ignored by the access query. */
export const SUBSCRIPTION_REF_PREFIX = 'sub_'

/** Purchased one-time pass. */
export const TRANSACTION_REF_PREFIX = 'txn_'

/**
 * Comped access, granted by an admin.
 *
 * Deliberately not `txn_`: both expire by date, but `txn_` claims a Paddle
 * transaction exists behind it, and reconciling revenue against a transaction
 * id Paddle has never heard of is a bad afternoon.
 */
export const COMP_REF_PREFIX = 'comp_'

/** A fresh, unique comp ref. UUID because the unique index is the only guard. */
export function compRef(): string {
  return `${COMP_REF_PREFIX}${crypto.randomUUID()}`
}

// ── Referral refs ────────────────────────────────────────────────────────────
// The one place in this table where a ref is DERIVED rather than minted, and
// that is the whole point. Every other prefix here randomises (`comp_` uses a
// UUID) or copies an id Paddle issued; these two are a pure function of the
// account the grant is about, so the unique index on `paddle_subscription_id`
// becomes the idempotency guarantee itself. A Paddle webhook redelivered five
// times computes the same ref five times and writes one row — no ledger table,
// no "have we already paid this out" flag that a race can read stale.
//
// Two prefixes rather than one because they are counted differently: the cap in
// server/utils/referral.ts counts a referrer's EARNED rewards with a LIKE on
// `referral_`, and a welcome grant the referrer once received for their own
// arrival must not eat into that budget.

/** The referrer's reward, one per referee they brought: `referral_<refereeId>`. */
export const REFERRAL_REF_PREFIX = 'referral_'

/** The referee's arrival bonus, one per account: `welcome_<userId>`. */
export const REFERRAL_WELCOME_REF_PREFIX = 'welcome_'

/**
 * The referrer's reward for one referee. Keyed by the REFEREE, not the
 * referrer: "this referral has been paid for" is the fact that must be unique,
 * and keying it the other way would cap a referrer at exactly one reward ever.
 */
export function referralRewardRef(refereeId: string): string {
  return `${REFERRAL_REF_PREFIX}${refereeId}`
}

/** The arrival bonus for one account. One per account, forever. */
export function referralWelcomeRef(userId: string): string {
  return `${REFERRAL_WELCOME_REF_PREFIX}${userId}`
}

/** Is this row access somebody earned through the referral loop? Labels history. */
export function isReferralRef(paddleRef: string): boolean {
  return (
    paddleRef.startsWith(REFERRAL_REF_PREFIX) || paddleRef.startsWith(REFERRAL_WELCOME_REF_PREFIX)
  )
}

/** Is this row an auto-renewing subscription Paddle manages? */
export function isSubscriptionRef(paddleRef: string): boolean {
  return paddleRef.startsWith(SUBSCRIPTION_REF_PREFIX)
}

/**
 * Is this ref time-limited access rather than an auto-renewing subscription?
 *
 * Keyed on the ABSENCE of `sub_` rather than the presence of `txn_`, so it
 * agrees with findActiveEntitlement — the query that decides whether a ref
 * grants access at all, and which treats `sub_` as the special case and every
 * other prefix as date-expiring. Any future ref shape inherits the right
 * behaviour instead of silently reading as a subscription.
 */
export function isPass(paddleRef: string): boolean {
  return !isSubscriptionRef(paddleRef)
}

/** Is this entitlement comped rather than paid? Used to label billing history. */
export function isCompRef(paddleRef: string): boolean {
  return paddleRef.startsWith(COMP_REF_PREFIX)
}
