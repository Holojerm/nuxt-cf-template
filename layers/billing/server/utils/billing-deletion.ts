// Account deletion that cancels the person's live Stripe subscription first
// (`runtimeConfig.billing.cancelOnDeletion`, off by default).
//
// Deleting the account does not touch Stripe, which owns the subscription's
// billing lifecycle: left alone, it keeps charging a card nobody can look up.
// The default answer is the deletion guard (billing-extensions.ts): refuse, and
// point at the billing portal. With the option on, billing registers this
// resolver instead, so the person does not have to leave to cancel. It is
// registered through core's DeletionResolver seam; core never imports it.
//
// ── Fails closed ─────────────────────────────────────────────────────────────
// Every subscription Stripe could still bill (isBillingLive: not terminal, not
// already scheduled to cancel) is cancelled immediately BEFORE anything is
// deleted. If any cancel fails, for any reason (no key, network, a missing
// `subscription.write` permission, a 5xx), the resolver returns a refusal with
// the same code and data shape as the guard, so the UI offers the portal as it
// always did. Stripe's "already cancelled" answers count as success: that state
// is final.
//
// ── What is recorded, and what is not ────────────────────────────────────────
// The audit row is written first (audit before act) and carries the `sub_` id
// only. A failure records the `deletion_cancel_failed` ops event with the id and
// Stripe's status and error code, never the response body (it can echo customer
// data), the address or the key.

import { eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import { withAudit } from '#server/utils/audit'
import type { DeletionBlock, DeletionResolver, ExtensionDb } from '#server/utils/extensions'
import { recordOpsEvent } from '#server/utils/ops'
import { isBillingLive } from './entitlements'
import { StripeApiError, cancelSubscription } from './stripe-api'
import { isSubscriptionRef } from './billing-refs'
import type { BillingEvent } from './entitlements'
import { logEvent } from '#server/utils/log'

/** The 409 `data.code` the account page reads. `billing.deletionRefusalCode` overrides it. */
export const DEFAULT_DELETION_REFUSAL_CODE = 'live_subscription'

/** Cancels one subscription immediately; throws if Stripe will not confirm it. */
export type CancelSubscription = (subscriptionId: string) => Promise<unknown>

/** Every `sub_` subscription Stripe might still bill, across all product keys. */
export async function findLiveSubscriptionRefs(db: ExtensionDb, userId: string): Promise<string[]> {
  const rows = await db
    .select({
      billingRef: tables.entitlements.billingRef,
      status: tables.entitlements.status,
      // Both columns isBillingLive reads. Without the scheduled change, an
      // already-cancelled subscription reads as live for its whole notice
      // period and blocks deletion for months.
      scheduledChangeAction: tables.entitlements.scheduledChangeAction,
    })
    .from(tables.entitlements)
    .where(eq(tables.entitlements.userId, userId))

  return rows
    .filter((row) => isSubscriptionRef(row.billingRef) && isBillingLive(row))
    .map((row) => row.billingRef)
}

/** The Stripe client wired to the deployment's key, from runtime config at call time. */
export function stripeCancelFromConfig(): CancelSubscription {
  return async (subscriptionId) => {
    const config = useRuntimeConfig()
    const secretKey = config.stripe.secretKey
    // An unset key refuses like any other failed cancel; it never skips one.
    if (!secretKey) throw new StripeApiError(0, 'unconfigured')
    return cancelSubscription({ secretKey, apiBase: config.stripe.apiBase, subscriptionId })
  }
}

function failureReason(error: unknown): string {
  return error instanceof StripeApiError
    ? `Stripe status ${error.status}, code ${error.code ?? 'none'}`
    : 'error before or outside the Stripe response'
}

export function createCancelOnDeletionResolver(opts: {
  refusalCode: string
  cancel: CancelSubscription
}): DeletionResolver {
  return {
    key: 'billing',
    async resolve(db, userId, context): Promise<DeletionBlock | null> {
      for (const subscriptionId of await findLiveSubscriptionRefs(db, userId)) {
        try {
          await withAudit(
            db,
            {
              actorUserId: userId,
              actorType: 'user',
              action: 'account.subscription_cancel_requested',
              targetType: 'user',
              targetId: userId,
              metadata: { subscriptionId },
              ipHash: context?.ipHash,
            },
            () => opts.cancel(subscriptionId),
          )
        } catch (error) {
          const reason = failureReason(error)
          logEvent('error', 'deletion_cancel_failed', { subscriptionId, reason })
          await recordOpsEvent(db, {
            kind: 'deletion_cancel_failed',
            detail: `${subscriptionId}: ${reason} — account deletion refused, nothing deleted`,
            path: '/api/account/delete',
          })
          return {
            code: opts.refusalCode,
            message:
              'We could not cancel your subscription, so nothing was deleted. ' +
              'Cancel it from the billing portal first, then delete your account.',
            data: { subscriptionId },
          }
        }
      }
      return null
    },
  }
}

/**
 * A `subscription.canceled` for an account that no longer exists is what the
 * cancel above produces in an app whose deletion removes the `users` row: the
 * echo of our own request. Deliberately narrow: only a canceled status. A
 * created, activated or renewed subscription (or a transaction) for a missing
 * account is money arriving for nobody and must keep alerting.
 */
export function isCancelEchoAfterDeletion(event: BillingEvent): boolean {
  return event.event_type.startsWith('subscription.') && event.data.status === 'canceled'
}
