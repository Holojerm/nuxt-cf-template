// What the billing feature contributes to core: the deletion guard, the data
// export's entitlements, the admin one-customer and "view as" payloads, fleet
// counters and the paid funnel stage, the onboarding signal, the paddle-event
// purge, the `pass_expiring` lifecycle step and the paywall gate itself.
// Registered once per isolate by this layer's layers/billing/server/plugins/billing.ts; tests call
// registerBillingExtensions() directly. See server/utils/extensions.ts.
//
// Core imports none of this. Remove billing (TEARDOWN.md) and core compiles and
// behaves as a free product: deletion unguarded, `requireAccess` allowing any
// signed-in user, no `entitlements` fleet group, funnel `paid` at 0.

import { and, count, countDistinct, desc, eq, inArray, like, lt, or } from 'drizzle-orm'
import * as tables from '../db/schema'
import { requireSubscription } from './billing'
import { passExpiringStep } from './billing-lifecycle'
import { buildEntitlementView } from './entitlement-view'
import type { EntitlementView } from './entitlement-view'
import { isBillingLive, setPassDays } from './entitlements'
import {
  registerAccountContributor,
  registerAdminUserContributor,
  registerAdminViewAsContributor,
  registerDeletionGuard,
  registerFleetCounterContributor,
  registerFunnelStageContributor,
  registerLifecycleStep,
  registerOnboardingSignalContributor,
  registerPurgeContributor,
} from '#server/utils/extensions'
import type { ExtensionDb } from '#server/utils/extensions'
import { registerAccessGate } from '#server/utils/access-gate'
import { isSubscriptionRef } from './paddle-refs'
import { PURGE_BATCH_LIMIT } from '#server/utils/purge'

/** One entitlement as the data export shows it. */
export interface AccountExportEntitlement {
  id: string
  paddleSubscriptionId: string
  productKey: string
  status: string
  currentPeriodEnd: string | null
  createdAt: string
}

declare module '#server/utils/extensions' {
  interface AccountExportSections {
    entitlements: AccountExportEntitlement[]
  }
  interface AdminUserSections {
    billing: EntitlementView
  }
  interface AdminViewAsSections {
    entitlement: EntitlementView
  }
  interface FleetCounterSections {
    entitlements: { byStatus: Record<string, number> }
  }
}

/** How long an applied Paddle event_id stays deduplicated. Paddle retries for ~3 days; 30 covers a manual replay. */
export const PADDLE_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60

/**
 * Is there a subscription behind this account that Paddle might still bill —
 * across every product it might have bought, not just `'default'`.
 *
 * Deliberately NOT `getBillingOverview(db, userId)`, which scopes to one
 * `productKey`. A deployment that sells more than one product could have a
 * live subscription on a non-default key, and the one guard that exists to stop
 * a customer getting billed after deletion must not miss it. Per-account row
 * counts are small, so one unfiltered read plus an in-memory scan is simpler
 * and safer than threading every product key through here.
 *
 * ── Billing-liveness, not access ─────────────────────────────────────────────
 * This used to key on ACTIVE_STATUSES, which is the rule for "does this grant
 * access". Wrong question, and wrong in the expensive direction: `past_due` and
 * `paused` grant no access and are exactly the two states that go on to charge
 * a card — one when a dunning retry succeeds, one when the customer unpauses.
 * A `past_due` account could therefore delete itself, and then renew. See
 * isBillingLive() in layers/billing/server/utils/entitlements.ts.
 */
export async function findLiveSubscriptionRef(
  db: ExtensionDb,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      paddleSubscriptionId: tables.entitlements.paddleSubscriptionId,
      status: tables.entitlements.status,
      // Both columns isBillingLive reads. Without the scheduled change, an
      // already-cancelled subscription reads as live for its whole notice
      // period and blocks deletion for months.
      scheduledChangeAction: tables.entitlements.scheduledChangeAction,
    })
    .from(tables.entitlements)
    .where(eq(tables.entitlements.userId, userId))

  const live = rows.find((row) => isSubscriptionRef(row.paddleSubscriptionId) && isBillingLive(row))
  return live?.paddleSubscriptionId ?? null
}

/** Per-app choices, from `runtimeConfig.billing` (layers/billing/nuxt.config.ts). */
export interface BillingOptions {
  /** Days one pass buys. Default 30. */
  passDays?: number
  /**
   * Register the deletion guard (refuse while a live subscription exists).
   * Default true. An app whose own deletion flow cancels the subscription at
   * Paddle first, and fails closed itself, sets this false: the guard would
   * refuse before that cancel could run, because the row only turns `canceled`
   * when Paddle's webhook arrives.
   */
  guardDeletion?: boolean
}

export function registerBillingExtensions(options: BillingOptions = {}): void {
  if (options.passDays !== undefined) setPassDays(options.passDays)

  // Deleting the `users` row does not touch Paddle, which owns the
  // subscription's billing lifecycle independently: refusing up front, and
  // pointing at the portal, is the one place friction protects the customer.
  // The wire contract (409, data.code) is read by app/pages/account.vue.
  if (options.guardDeletion !== false) {
    registerDeletionGuard({
      key: 'billing',
      async check(db, userId) {
        const subscriptionId = await findLiveSubscriptionRef(db, userId)
        if (!subscriptionId) return null
        return {
          code: 'live_subscription',
          message:
            'Deleting your account would not stop the charges — Paddle owns the subscription, ' +
            'not this account. Cancel it from the billing portal first, then delete your account.',
          data: { subscriptionId },
        }
      },
    })
  }

  // Export-only: entitlements are retained on deletion (billing records kept
  // as tax law requires; the `users` row survives as a tombstone), so there is
  // no count and no deletion statement here.
  registerAccountContributor({
    key: 'entitlements',
    async exportSection(db, userId) {
      const rows = await db.query.entitlements.findMany({
        where: eq(tables.entitlements.userId, userId),
        orderBy: desc(tables.entitlements.createdAt),
      })
      return rows.map((entitlement) => ({
        id: entitlement.id,
        paddleSubscriptionId: entitlement.paddleSubscriptionId,
        productKey: entitlement.productKey,
        status: entitlement.status,
        currentPeriodEnd: entitlement.currentPeriodEnd?.toISOString() ?? null,
        createdAt: entitlement.createdAt.toISOString(),
      }))
    },
  })

  registerAdminUserContributor({
    key: 'billing',
    load: (db, userId) => buildEntitlementView(db, userId),
  })

  registerAdminViewAsContributor({
    key: 'entitlement',
    async load(db, userId) {
      const value = await buildEntitlementView(db, userId)
      return { value, gates: { subscription: value.active } }
    },
  })

  registerFleetCounterContributor({
    key: 'entitlements',
    async collect(db) {
      const rows = await db
        .select({ status: tables.entitlements.status, total: count() })
        .from(tables.entitlements)
        .groupBy(tables.entitlements.status)
      const byStatus: Record<string, number> = {}
      for (const row of rows) byStatus[row.status] = row.total
      return { byStatus }
    },
  })

  registerFunnelStageContributor({
    key: 'paid',
    async count(db, cohort) {
      // `txn_` passes and `sub_` subscriptions are Paddle's ids; `comp_` and the
      // referral grants are minted here and must not read as revenue.
      const [paid] = await db
        .select({ total: countDistinct(tables.entitlements.userId) })
        .from(tables.entitlements)
        .where(
          and(
            inArray(tables.entitlements.userId, cohort),
            or(
              like(tables.entitlements.paddleSubscriptionId, 'txn_%'),
              like(tables.entitlements.paddleSubscriptionId, 'sub_%'),
            ),
          ),
        )
      return paid?.total ?? 0
    },
  })

  registerOnboardingSignalContributor({
    key: 'billing',
    async read(db, userId) {
      return { entitlementActive: (await buildEntitlementView(db, userId)).active }
    },
  })

  // Its own window, not `graceSeconds`: the dedup row has to outlive Paddle's
  // retry schedule, and a 24h grace would let a day-old redelivery re-apply.
  registerPurgeContributor({
    key: 'paddleEvents',
    async run(db, options) {
      const { now = Date.now(), limit = PURGE_BATCH_LIMIT } = options
      const cutoff = new Date(now - PADDLE_EVENT_RETENTION_SECONDS * 1000)
      const dead = db
        .select({ eventId: tables.paddleEvents.eventId })
        .from(tables.paddleEvents)
        .where(lt(tables.paddleEvents.receivedAt, cutoff))
        .limit(limit)
      const deleted = await db
        .delete(tables.paddleEvents)
        .where(inArray(tables.paddleEvents.eventId, dead))
        .returning({ eventId: tables.paddleEvents.eventId })
      return { count: deleted.length, truncated: deleted.length >= limit }
    },
  })

  registerLifecycleStep(passExpiringStep)
  registerAccessGate(requireSubscription)
}
