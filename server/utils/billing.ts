// Subscription gating built on the entitlements table (populated by the Paddle
// webhook). Auto-imported Nitro-wide like every server util.
//
// This file is the H3-facing half: "does the caller get in?". The writes and
// the entitlement query itself live in server/utils/entitlements.ts, which
// takes the db explicitly so it can be tested.

import type { H3Event } from 'h3'
import type { Entitlement } from '../db/schema'

/**
 * The user's granting entitlement for a product, or null.
 *
 * `sub_…` rows are status-driven (Paddle flips the status when they end);
 * `txn_…` passes expire by timestamp because no lifecycle event ever fires.
 */
export async function getEntitlement(
  userId: string,
  productKey = 'default',
): Promise<Entitlement | null> {
  return findActiveEntitlement(db, userId, productKey)
}

/**
 * Require a signed-in user with an active subscription. Composes on
 * requireUserSession (nuxt-auth-utils): 401 when signed out, 402 when signed
 * in without an entitlement. Returns the session user + entitlement.
 *
 *   const { user, entitlement } = await requireSubscription(event)
 */
export async function requireSubscription(event: H3Event, productKey = 'default') {
  const { user } = await requireUserSession(event)
  const entitlement = await getEntitlement(user.id, productKey)
  if (!entitlement) {
    throw createError({
      statusCode: 402,
      message: 'Subscription required',
      data: { code: 'subscription_required', productKey },
    })
  }
  return { user, entitlement }
}

/**
 * Is this ref time-limited access rather than an auto-renewing subscription?
 *
 * Keyed on the ABSENCE of `sub_` rather than the presence of `txn_`, so it
 * agrees with findActiveEntitlement() — the query that decides whether a ref
 * grants access at all, and which treats `sub_` as the special case and every
 * other prefix as date-expiring.
 *
 * The two used to disagree, harmlessly, while `txn_` was the only other shape
 * in the table. It stopped being harmless when the admin console started
 * writing `comp_` refs (server/utils/admin-grants.ts): under the old rule a
 * comped month read as a *subscription*, so /account told the customer it
 * "renews automatically" and offered to cancel something that does not exist.
 * Any future ref shape would have inherited the same bug.
 */
export function isPass(paddleRef: string): boolean {
  return !paddleRef.startsWith('sub_')
}
