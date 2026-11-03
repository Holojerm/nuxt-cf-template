// Account deletion that cancels the person's live Paddle subscription first
// (`runtimeConfig.billing.cancelOnDeletion`, off by default).
//
// Deleting the account does not touch Paddle, which owns the subscription's
// billing lifecycle: left alone, it keeps charging a card nobody can look up.
// The default answer is the deletion guard (billing-extensions.ts): refuse, and
// point at the billing portal. With the option on, billing registers this
// resolver instead, so the person does not have to leave to cancel. It is
// registered through core's DeletionResolver seam; core never imports it.
//
// ── Fails closed ─────────────────────────────────────────────────────────────
// Every subscription Paddle could still bill (isBillingLive: not terminal, not
// already scheduled to cancel) is cancelled immediately BEFORE anything is
// deleted. If any cancel fails, for any reason (no key, network, a missing
// `subscription.write` permission, a 5xx), the resolver returns a refusal with
// the same code and data shape as the guard, so the UI offers the portal as it
// always did. Paddle's "already cancelled" answers count as success: that state
// is final.
//
// ── What is recorded, and what is not ────────────────────────────────────────
// The audit row is written first (audit before act) and carries the `sub_` id
// only. A failure records the `deletion_cancel_failed` ops event with the id and
// Paddle's status and error code, never the response body (it can echo customer
// data), the address or the key.

import { eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import { withAudit } from '#server/utils/audit'
import type { DeletionBlock, DeletionResolver, ExtensionDb } from '#server/utils/extensions'
import { recordOpsEvent } from '#server/utils/ops'
import { isBillingLive } from './entitlements'
import { PaddleApiError, cancelSubscription } from './paddle-api'
import { isSubscriptionRef } from './paddle-refs'
import type { PaddleEvent } from './entitlements'

/** The 409 `data.code` the account page reads. `billing.deletionRefusalCode` overrides it. */
export const DEFAULT_DELETION_REFUSAL_CODE = 'live_subscription'

/** Cancels one subscription immediately; throws if Paddle will not confirm it. */
export type CancelSubscription = (subscriptionId: string) => Promise<unknown>

/** Every `sub_` subscription Paddle might still bill, across all product keys. */
export async function findLiveSubscriptionRefs(db: ExtensionDb, userId: string): Promise<string[]> {
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

  return rows
    .filter((row) => isSubscriptionRef(row.paddleSubscriptionId) && isBillingLive(row))
    .map((row) => row.paddleSubscriptionId)
}

/** The Paddle client wired to the deployment's key, from runtime config at call time. */
export function paddleCancelFromConfig(): CancelSubscription {
  return async (subscriptionId) => {
    const config = useRuntimeConfig()
    const apiKey = config.paddle.apiKey
    // An unset key refuses like any other failed cancel; it never skips one.
    if (!apiKey) throw new PaddleApiError(0, 'unconfigured')
    return cancelSubscription({
      apiKey,
      environment: config.public.paddleEnv,
      apiBase: config.paddle.apiBase,
      subscriptionId,
    })
  }
}

function failureReason(error: unknown): string {
  return error instanceof PaddleApiError
    ? `Paddle status ${error.status}, code ${error.code ?? 'none'}`
    : 'error before or outside the Paddle response'
}

export function createCancelOnDeletionResolver(opts: {
  refusalCode: string
  cancel: CancelSubscription
}): DeletionResolver {
  return {
    key: 'billing',
    async resolve(db, userId): Promise<DeletionBlock | null> {
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
            },
            () => opts.cancel(subscriptionId),
          )
        } catch (error) {
          const reason = failureReason(error)
          console.error(
            JSON.stringify({
              kind: 'deletion_cancel_failed',
              subscriptionId,
              reason,
            }),
          )
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
export function isCancelEchoAfterDeletion(event: PaddleEvent): boolean {
  return event.event_type.startsWith('subscription.') && event.data.status === 'canceled'
}
