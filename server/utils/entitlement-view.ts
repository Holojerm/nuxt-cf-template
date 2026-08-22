// The customer's own view of their billing, as one function.
//
// This is the shape GET /api/billing/entitlement returns — extracted from that
// handler rather than copied, because the admin console's read-only "view as"
// (server/api/admin/users/[id]/view-as.get.ts) has to render *exactly* what the
// customer sees. A support tool that shows a near-copy of the customer's screen
// is worse than no tool: you debug the difference between the two views instead
// of the bug the customer reported, and nothing tells you that's what happened.
//
// One function, two callers, no drift by construction.

import { isCompRef, isPass, isSubscriptionRef } from './paddle-refs'
import { deriveBillingState } from './billing-state'
import type { BillingState } from './billing-state'
import { ACTIVE_STATUSES, getBillingOverview } from './entitlements'
import type { EntitlementDb } from './entitlements'

export interface EntitlementHistoryView {
  ref: string
  kind: 'pass' | 'subscription'
  /** True when this row was comped by an admin rather than paid for. */
  comped: boolean
  status: string
  currentPeriodEnd: string | null
  purchasedAt: string
}

export interface EntitlementView {
  active: boolean
  /**
   * The one word every surface branches on — customer and admin console alike.
   *
   * `active: false` is three situations wearing one face: never subscribed,
   * ended, and a payment that failed and is being retried. Only the last has an
   * action attached, and describing it lives here rather than in a caller
   * precisely so /account and the support console cannot tell a customer two
   * different stories about the same failed card.
   */
  state: BillingState
  status: string | null
  currentPeriodEnd: string | null
  /** 'pass' = one-time, nothing to cancel; 'subscription' = renewing. */
  kind: 'pass' | 'subscription' | null
  comped: boolean
  /** Live subscriptions the user could cancel (usually 0 or 1). */
  cancellable: number
  /** Whether a Paddle customer portal link can be minted at all. */
  portalAvailable: boolean
  history: EntitlementHistoryView[]
}

export interface BuildEntitlementViewOptions {
  productKey?: string
  /**
   * Whether NUXT_PADDLE_API_KEY is set — the caller reads runtime config.
   *
   * Required, not optional. Omitting it used to default to `false`, which
   * silently hid the "Update payment method" button — the single recovery
   * action on the dunning screen — on any caller that forgot the flag. A
   * missing argument should be a type error, not an invisible downgrade of the
   * one path a customer in dunning has.
   */
  portalConfigured: boolean
}

export async function buildEntitlementView(
  db: EntitlementDb,
  userId: string,
  options: BuildEntitlementViewOptions,
): Promise<EntitlementView> {
  const overview = await getBillingOverview(db, userId, options.productKey)

  // ── Which row describes this account? ──────────────────────────────────────
  // NOT simply findActiveEntitlement's pick. That query orders by
  // `current_period_end DESC`, so a comp stacked past a subscription's renewal
  // date outranks the subscription — and then a paying monthly customer was
  // told "You have a one-time pass. It will not renew." beside a working
  // "Manage or cancel" button for the subscription the same page had just
  // decided did not exist.
  //
  // A live subscription is authoritative whenever one exists, whatever the
  // dates say. It is the thing that renews, the thing that can be cancelled,
  // and the thing the customer is being charged for; anything else granting
  // access alongside it is additive, not descriptive. `past_due` subs are
  // excluded by ACTIVE_STATUSES — during dunning a comp really is the only
  // thing granting access, and it should say so.
  const liveSubscription =
    overview.history.find(
      (row) => isSubscriptionRef(row.paddleSubscriptionId) && ACTIVE_STATUSES.includes(row.status),
    ) ?? null
  const describing = liveSubscription ?? overview.active

  return {
    // Still keyed on the access query: "do they get in" is a different question
    // from "what should we call their plan", and only the former gates anything.
    active: Boolean(overview.active),
    state: deriveBillingState(overview.active, overview.history),
    status: describing?.status ?? null,
    currentPeriodEnd: describing?.currentPeriodEnd?.toISOString() ?? null,
    kind: describing ? (isPass(describing.paddleSubscriptionId) ? 'pass' : 'subscription') : null,
    comped: describing ? isCompRef(describing.paddleSubscriptionId) : false,
    cancellable: overview.subscriptionIds.length,
    portalAvailable: Boolean(overview.paddleCustomerId) && options.portalConfigured,
    history: overview.history.map((entitlement) => ({
      ref: entitlement.paddleSubscriptionId,
      kind: isPass(entitlement.paddleSubscriptionId) ? 'pass' : 'subscription',
      comped: isCompRef(entitlement.paddleSubscriptionId),
      status: entitlement.status,
      currentPeriodEnd: entitlement.currentPeriodEnd?.toISOString() ?? null,
      purchasedAt: entitlement.createdAt.toISOString(),
    })),
  }
}
