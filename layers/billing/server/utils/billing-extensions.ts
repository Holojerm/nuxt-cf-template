// What the billing feature contributes to core: the deletion guard, the data
// export's entitlements, the admin one-customer and "view as" payloads, fleet
// counters and the paid funnel stage, the onboarding signal, the paddle-event
// purge, the `pass_expiring` lifecycle step, the paywall gate itself and the
// earned-access provider other features grant days through.
// Registered once per isolate by this layer's layers/billing/server/plugins/billing.ts; tests call
// registerBillingExtensions() directly. See server/utils/extensions.ts.
//
// Core imports none of this. Remove billing (TEARDOWN.md) and core compiles and
// behaves as a free product: deletion unguarded, `requireAccess` allowing any
// signed-in user, no `entitlements` fleet group, funnel `paid` at 0.

import { and, count, countDistinct, desc, eq, inArray, like, lt, or } from 'drizzle-orm'
import * as tables from '../db/schema'
import { requireSubscription } from './billing'
import {
  DEFAULT_DELETION_REFUSAL_CODE,
  createCancelOnDeletionResolver,
  findLiveSubscriptionRefs,
  isCancelEchoAfterDeletion,
  paddleCancelFromConfig,
} from './billing-deletion'
import type { CancelSubscription } from './billing-deletion'
import { registerUnknownUserExpectation } from './billing-expectations'
import { billingEarnedAccess } from './billing-earned-access'
import { setBillingNotify, setSkipUndeliverableRecipients } from './billing-notifications'
import { passExpiringStep } from './billing-lifecycle'
import { buildEntitlementView } from './entitlement-view'
import type { EntitlementView } from './entitlement-view'
import { setPassDays, setStackAtBilled } from './entitlements'
import {
  registerAccountContributor,
  registerAdminUserContributor,
  registerAdminViewAsContributor,
  registerDeletionGuard,
  registerDeletionResolver,
  registerFleetCounterContributor,
  registerFunnelStageContributor,
  registerLifecycleStep,
  registerOnboardingSignalContributor,
  registerPurgeContributor,
} from '#server/utils/extensions'
import type { ExtensionDb } from '#server/utils/extensions'
import { registerAccessGate } from '#server/utils/access-gate'
import { registerEarnedAccess } from '#server/utils/earned-access'
import { registerEntitlementViewFields } from '#server/utils/entitlement-view-fields'
import { registerOpsSeverity } from '#server/utils/ops-severity'
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

declare module '#server/utils/entitlement-view-fields' {
  interface EntitlementViewFields {
    /**
     * Present (true) only with `billing.cancelOnDeletion` on: deleting the
     * account cancels a live subscription first. The account page words its
     * delete modal from it.
     */
    cancelsOnDeletion?: boolean
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
  // The scan lives in billing-deletion.ts beside the cancel path, which needs
  // every live id; this is its first.
  return (await findLiveSubscriptionRefs(db, userId))[0] ?? null
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
  /**
   * Cancel the person's live subscriptions at Paddle, immediately, when they
   * delete their account, instead of refusing until they have done it in the
   * portal. Default false. On, billing registers a DeletionResolver in place of
   * the guard (so `guardDeletion` is moot) and deletion fails closed: if any
   * cancel fails the 409 is the guard's, same code. Needs `subscription.write`
   * on NUXT_PADDLE_API_KEY. See billing-deletion.ts.
   */
  cancelOnDeletion?: boolean
  /**
   * The 409 `data.code` for a deletion refused over a live subscription, by the
   * guard and by a failed cancel alike. Default `live_subscription`, which the
   * template's account page reads. An app with its own client sets its own.
   */
  deletionRefusalCode?: string
  /**
   * Send the customer emails (purchase, payment failed, access ended, comp
   * granted and revoked). Default true. An app that sends no customer email
   * sets it false; the pass-expiring lifecycle step is only ever sent by
   * core's lifecycle task, so an app without that task needs nothing else.
   */
  notify?: boolean
  /**
   * Stack a new pass on the access that was running when it was BOUGHT, not
   * when the webhook was processed. Default false (the wall clock). Only differs
   * when delivery lagged past the old pass's end; true keeps the customer's
   * overlap. See setStackAtBilled in entitlements.ts.
   */
  stackAtBilledAt?: boolean
}

/** Test seam: replace the Paddle call the cancel-on-deletion resolver makes. */
export interface BillingExtensionDeps {
  cancelSubscription?: CancelSubscription
}

export function registerBillingExtensions(
  options: BillingOptions = {},
  deps: BillingExtensionDeps = {},
): void {
  // Every other billing kind is a warning, the default. A missing webhook
  // secret is not: every billing event is refused, so customers pay and get
  // nothing until it is set (Paddle keeps retrying, so nothing is lost yet).
  registerOpsSeverity({
    paddle_webhook_unconfigured: {
      severity: 'critical',
      action:
        'Paid customers are not getting access. Set NUXT_PADDLE_WEBHOOK_SECRET on the Worker; Paddle redelivers the refused events on its own.',
    },
  })
  if (options.passDays !== undefined) setPassDays(options.passDays)
  if (options.notify !== undefined) setBillingNotify(options.notify)
  if (options.stackAtBilledAt !== undefined) setStackAtBilled(options.stackAtBilledAt)

  // Deleting the `users` row does not touch Paddle, which owns the
  // subscription's billing lifecycle independently: refusing up front, and
  // pointing at the portal, is the one place friction protects the customer.
  // The wire contract (409, data.code) is read by app/pages/account.vue.
  setSkipUndeliverableRecipients(options.cancelOnDeletion === true)
  const refusalCode = options.deletionRefusalCode || DEFAULT_DELETION_REFUSAL_CODE
  if (options.cancelOnDeletion === true) {
    // The resolver is the guard here: it refuses, with the guard's code, when it
    // cannot cancel. Registering the guard too would refuse before it could run,
    // because a row only turns `canceled` when Paddle's webhook arrives.
    registerDeletionResolver(
      createCancelOnDeletionResolver({
        refusalCode,
        cancel: deps.cancelSubscription ?? paddleCancelFromConfig(),
      }),
    )
    // The echo of our own cancel (`subscription.canceled`) arrives after the
    // account is gone. Here the tombstone row keeps the entitlement, so it is
    // applied (and the access-ended email to the `.invalid` address is skipped).
    // For an app whose deletion removes the row it names no account: expected,
    // not an alert.
    registerUnknownUserExpectation('billing-cancel-on-deletion', isCancelEchoAfterDeletion)
    registerEntitlementViewFields({
      key: 'billing-deletion',
      view: () => ({ cancelsOnDeletion: true }),
    })
  } else if (options.guardDeletion !== false) {
    registerDeletionGuard({
      key: 'billing',
      async check(db, userId) {
        const subscriptionId = await findLiveSubscriptionRef(db, userId)
        if (!subscriptionId) return null
        return {
          code: refusalCode,
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
  // Where a feature that hands out access nobody paid for (the referral loop)
  // writes its days: stacked on what the person holds, counted, clawed back.
  registerEarnedAccess(billingEarnedAccess)
}
