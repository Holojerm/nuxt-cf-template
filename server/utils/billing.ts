// Subscription gating built on the entitlements table (populated by the Paddle
// webhook). Auto-imported Nitro-wide like every server util.

import { and, eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { Entitlement } from '../db/schema'

/** Statuses that grant access. `past_due` is grace-period territory — excluded by default. */
const ACTIVE_STATUSES = ['active', 'trialing']

/** The user's granting entitlement for a product, or null. */
export async function getEntitlement(
  userId: string,
  productKey = 'default',
): Promise<Entitlement | null> {
  const row = await db.query.entitlements.findFirst({
    where: and(
      eq(schema.entitlements.userId, userId),
      eq(schema.entitlements.productKey, productKey),
      inArray(schema.entitlements.status, ACTIVE_STATUSES),
    ),
  })
  return row ?? null
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
