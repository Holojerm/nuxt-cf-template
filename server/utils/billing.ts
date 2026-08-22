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

// `isPass` used to live here. It moved to server/utils/paddle-refs.ts, along
// with every other rule about what a ref prefix means, because four files were
// reading that rule and this one is not a leaf — it reaches back into
// entitlements.ts, which also needs the predicate. Nitro auto-imports the new
// home Nitro-wide, so call sites are unchanged.
