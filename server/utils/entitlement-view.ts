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

import { isPass } from './billing'
import { isCompRef } from './admin-grants'
import { getBillingOverview } from './entitlements'
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
  /** Whether NUXT_PADDLE_API_KEY is set — the caller reads runtime config. */
  portalConfigured?: boolean
}

export async function buildEntitlementView(
  db: EntitlementDb,
  userId: string,
  options: BuildEntitlementViewOptions = {},
): Promise<EntitlementView> {
  const overview = await getBillingOverview(db, userId, options.productKey)
  const active = overview.active

  return {
    active: Boolean(active),
    status: active?.status ?? null,
    currentPeriodEnd: active?.currentPeriodEnd?.toISOString() ?? null,
    kind: active ? (isPass(active.paddleSubscriptionId) ? 'pass' : 'subscription') : null,
    comped: active ? isCompRef(active.paddleSubscriptionId) : false,
    cancellable: overview.subscriptionIds.length,
    portalAvailable: Boolean(overview.paddleCustomerId) && Boolean(options.portalConfigured),
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
