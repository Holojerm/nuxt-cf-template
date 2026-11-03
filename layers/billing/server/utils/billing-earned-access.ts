// Billing's side of the earned-access seam (server/utils/earned-access.ts):
// plans, writes, finds and counts grants in the `entitlements` table on behalf
// of a feature that hands out access nobody paid for. Moved verbatim from the
// referral loop, which wrote these rows itself while it lived beside billing;
// the reasoning on each function was written there and holds here unchanged.

import { and, count, eq, ne } from 'drizzle-orm'
import * as tables from '../db/schema'
import type { EarnedAccessProvider, EarnedGrantParams } from '#server/utils/earned-access'
import type { EarnedGrantPlan } from '#server/utils/earned-access'
import type { ExtensionDb } from '#server/utils/extensions'
import { likePrefix } from '#server/utils/sql'
import { DERIVED_REVOKED_STATUS, getBillingOverview, stackingBase, toSeconds } from './entitlements'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Work out what a grant would do, without writing anything.
 *
 * Split from the write so the caller can decide — and audit — before acting.
 * server/utils/audit.ts's policy is that the audit row describes intent and is
 * written first; a row saying "rewarded" in front of a grant that was about to
 * be refused would be the opposite of a record.
 *
 * ── A live subscriber IS paid, unlike a comp ─────────────────────────────────
 * This used to refuse whenever a subscription was already granting access,
 * copied from grantCompPasses(). It was the wrong rule in the wrong place, and
 * the reason is that a comp and an earned reward differ in who is owed what.
 *
 * A comp is an apology an operator chooses to send, so refusing it and naming a
 * better instrument (a Paddle credit) is good support. A referral reward has
 * already been EARNED, by somebody who read "you get 30 days when they pay" on
 * their own account page and then went and did it. Refusing costs them the
 * reward permanently — the trigger is a one-time transaction, so nothing ever
 * retries — and it fails precisely the referrers most worth having, since the
 * people who recommend a product are overwhelmingly the ones already paying for
 * it. Silently not paying your best customers is not a fraud control.
 *
 * So the days are written, stacked from the running expiry, which for a
 * subscriber is their renewal date: the reward begins when the subscription
 * ends. That is honest and it is what the share card now says. The old worry —
 * that the granted row outranks the subscription in findActiveEntitlement's
 * `ORDER BY current_period_end DESC` and makes /account misdescribe the plan —
 * was fixed independently in entitlement-view.ts, which pins the description to
 * a live `sub_` row whatever the dates say.
 *
 * The stacking base is `overview.active`, the longest-running granting row,
 * rather than the subscription specifically: if a pass runs past the renewal,
 * stacking on the renewal would throw away days the customer already holds.
 * A `sub_` row with no `current_period_end` (Paddle always sends one; a null
 * would mean a malformed event) has nothing to anchor on and starts today.
 */
async function planEarnedGrant(
  db: ExtensionDb,
  params: EarnedGrantParams,
): Promise<EarnedGrantPlan> {
  const productKey = params.productKey ?? 'default'
  const now = params.now ?? new Date()

  const overview = await getBillingOverview(db, params.userId, productKey)

  // The shared rule, not a second copy of it — admin-grants.ts stacks comps
  // with the same helper, and "nobody loses days they already have" must not be
  // able to differ between two ways of granting.
  const stackedOn = stackingBase(overview.active, now)
  const base = stackedOn ?? now

  return {
    ref: params.ref,
    days: params.days,
    startsAt: toSeconds(base),
    endsAt: toSeconds(new Date(base.getTime() + params.days * DAY_MS)),
    stackedOn,
    productKey,
    userId: params.userId,
    earnedFromRef: params.earnedFromRef ?? null,
  }
}

/**
 * Write one planned grant. Idempotent on the ref, by the unique index.
 *
 * ── Why DO NOTHING rather than grantPass's DO UPDATE ─────────────────────────
 * grantPass() infers "did this insert land?" by comparing the date it computed
 * against the date that came back from an upsert: on a redelivery the stored
 * value is whatever the first delivery wrote and the recomputed one has stacked
 * on top of it, so they differ. That inference is sound for a purchased pass
 * and NOT sound here, and the difference is the welcome grant.
 *
 * A welcome grant lands on an account with no entitlements, so its date is
 * always `now + 7 days` — recomputed identically on every attempt. Two attempts
 * inside the same second therefore produce the same truncated timestamp, the
 * comparison says "matches", and a conflict that wrote nothing is reported as a
 * fresh grant. The row stays correct (the index still refuses the duplicate),
 * but the RETURN VALUE lies, and it lies in the direction of "we just gave this
 * person a trial" — which is what the delete-and-re-register test caught.
 *
 * `DO NOTHING … RETURNING` has no inference in it: SQLite returns a row when it
 * inserted one and no rows when it skipped, so `granted` is the database's own
 * answer. The only thing given up is the `updated_at` bump on a redelivery,
 * which recorded nothing anybody reads.
 */
async function writeEarnedGrant(
  db: ExtensionDb,
  plan: EarnedGrantPlan,
): Promise<{ granted: boolean; endsAt: Date }> {
  const inserted = await db
    .insert(tables.entitlements)
    .values({
      userId: plan.userId,
      paddleSubscriptionId: plan.ref,
      productKey: plan.productKey,
      status: 'active',
      // Both ends of the window. The start is what the clawback measures the
      // unspent remainder from — see `period_start` in the layer's schema.
      periodStart: plan.startsAt,
      currentPeriodEnd: plan.endsAt,
      // The purchase this row exists because of, or null for a welcome grant
      // (nobody bought anything). This is what lets a refund find the reward it
      // paid for — see `earned_from_ref` in the layer's schema.
      earnedFromRef: plan.earnedFromRef,
    })
    .onConflictDoNothing({ target: tables.entitlements.paddleSubscriptionId })
    .returning({ currentPeriodEnd: tables.entitlements.currentPeriodEnd })

  const row = inserted[0]
  if (row?.currentPeriodEnd) return { granted: true, endsAt: row.currentPeriodEnd }

  // Skipped: this ref already exists. Report the window that is actually in
  // force rather than the one this call would have written, so a caller never
  // tells somebody about days they do not have.
  const existing = await db.query.entitlements.findFirst({
    where: eq(tables.entitlements.paddleSubscriptionId, plan.ref),
    columns: { currentPeriodEnd: true },
  })
  return { granted: false, endsAt: existing?.currentPeriodEnd ?? plan.endsAt }
}

/**
 * Has this exact grant already been made?
 *
 * A point lookup on the unique index, and its only job is to keep the audit row
 * honest: audit-before-act means a payout that the index was always going to
 * refuse would otherwise leave a `referral.rewarded` row behind a grant that
 * never happened. The index is still the real guard — this read can be raced,
 * and losing that race costs one spurious audit row and no extra days.
 */
async function earnedGrantExists(db: ExtensionDb, ref: string): Promise<boolean> {
  const row = await db.query.entitlements.findFirst({
    where: eq(tables.entitlements.paddleSubscriptionId, ref),
    columns: { id: true },
  })
  return Boolean(row)
}

/**
 * How many of a user's rows carry a ref with this prefix.
 *
 * `standingOnly` leaves out rows clawed back (`revoked`): the cap on payouts
 * counts every one ever made (spent is spent), while what a person has actually
 * been given counts only those that still stand.
 */
async function countEarnedGrants(
  db: ExtensionDb,
  userId: string,
  prefix: string,
  options: { standingOnly?: boolean } = {},
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(tables.entitlements)
    .where(
      and(
        eq(tables.entitlements.userId, userId),
        // Escaped, because `_` is a LIKE wildcard — see server/utils/sql.ts.
        likePrefix(tables.entitlements.paddleSubscriptionId, prefix),
        ...(options.standingOnly ? [ne(tables.entitlements.status, DERIVED_REVOKED_STATUS)] : []),
      ),
    )
  return row?.total ?? 0
}

export const billingEarnedAccess: EarnedAccessProvider = {
  plan: planEarnedGrant,
  write: writeEarnedGrant,
  exists: earnedGrantExists,
  countByPrefix: countEarnedGrants,
}
