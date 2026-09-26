// The template's lifecycle steps. A fork adds its own in lifecycle-app-steps.ts
// (shipped empty, never edited by the template) — typically a win-back keyed on
// whatever "used the product" means there, which the template cannot know.

import { and, eq, gt, inArray, lte, notExists, sql } from 'drizzle-orm'

import { alias } from 'drizzle-orm/sqlite-core'

import * as tables from '../db/schema'
import { ACTIVE_STATUSES } from './entitlements'
import { activationNudgeEmail, passExpiringEmail } from './lifecycle-emails'
import type { LifecycleDb, LifecycleRecipient, LifecycleStep } from './lifecycle'
import { SUBSCRIPTION_REF_PREFIX, TRANSACTION_REF_PREFIX } from './paddle-refs'
import { likePrefix } from './sql'

const DAY_MS = 24 * 60 * 60 * 1000

/** A second handle on `entitlements`, for "does a subscription cover this user?". */
const renewing = alias(tables.entitlements, 'renewing')

function sentBefore(stepId: string) {
  return notExists(
    sql`(select 1 from ${tables.lifecycleSends} where ${tables.lifecycleSends.stepId} = ${stepId} and ${tables.lifecycleSends.userId} = ${tables.users.id})`,
  )
}

/** Signed up 1–7 days ago and never completed onboarding. */
export const activationNudgeStep: LifecycleStep = {
  id: 'activation_nudge',
  notification: 'tips',
  async due(db: LifecycleDb, now: Date, limit: number): Promise<LifecycleRecipient[]> {
    const rows = await db
      .select({ userId: tables.users.id, email: tables.users.email, name: tables.users.name })
      .from(tables.users)
      .where(
        and(
          gt(tables.users.createdAt, new Date(now.getTime() - 7 * DAY_MS)),
          lte(tables.users.createdAt, new Date(now.getTime() - DAY_MS)),
          notExists(
            sql`(select 1 from ${tables.auditLog} where ${tables.auditLog.action} = 'onboarding.activated' and ${tables.auditLog.actorUserId} = ${tables.users.id})`,
          ),
          sentBefore('activation_nudge'),
        ),
      )
      .limit(limit)
    return rows.map((row) => ({ ...row, subjectKey: '' }))
  },
  render: (brand, recipient) => activationNudgeEmail(brand, { name: recipient.name }),
}

/**
 * A paid pass ends within 3 days and nothing takes over from it: no active
 * subscription, no later pass stacked behind it. Comps and referral grants are
 * left out — "you won't be charged" would be true but the pass copy is not.
 */
export const passExpiringStep: LifecycleStep = {
  id: 'pass_expiring',
  notification: 'billing.pass_expiring',
  async due(db: LifecycleDb, now: Date, limit: number): Promise<LifecycleRecipient[]> {
    const ends = sql<number>`max(${tables.entitlements.currentPeriodEnd})`
    const rows = await db
      .select({
        userId: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        productKey: tables.entitlements.productKey,
        endsAt: ends,
      })
      .from(tables.entitlements)
      .innerJoin(tables.users, eq(tables.users.id, tables.entitlements.userId))
      .where(
        and(
          inArray(tables.entitlements.status, ACTIVE_STATUSES),
          gt(tables.entitlements.currentPeriodEnd, now),
          notExists(
            db
              .select({ id: renewing.id })
              .from(renewing)
              .where(
                and(
                  eq(renewing.userId, tables.entitlements.userId),
                  eq(renewing.productKey, tables.entitlements.productKey),
                  inArray(renewing.status, ACTIVE_STATUSES),
                  likePrefix(renewing.paddleSubscriptionId, SUBSCRIPTION_REF_PREFIX),
                ),
              ),
          ),
        ),
      )
      .groupBy(tables.entitlements.userId, tables.entitlements.productKey)
      // The LATEST end across every live row, so a stacked pass defers the
      // reminder to the one that actually ends access. Only then is the last
      // row checked for being a paid pass.
      .having(
        and(
          lte(ends, sql`${Math.floor((now.getTime() + 3 * DAY_MS) / 1000)}`),
          sql`max(case when ${likePrefix(tables.entitlements.paddleSubscriptionId, TRANSACTION_REF_PREFIX)} then ${tables.entitlements.currentPeriodEnd} end) = ${ends}`,
        ),
      )
      .limit(limit)
    return rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      name: row.name,
      subjectKey: `${row.productKey}:${row.endsAt}`,
      data: { endsAt: String(row.endsAt) },
    }))
  },
  render: (brand, recipient) =>
    passExpiringEmail(brand, {
      name: recipient.name,
      endsAt: new Date(Number(recipient.data?.endsAt ?? 0) * 1000),
    }),
}

export const TEMPLATE_LIFECYCLE_STEPS: readonly LifecycleStep[] = [
  activationNudgeStep,
  passExpiringStep,
]
