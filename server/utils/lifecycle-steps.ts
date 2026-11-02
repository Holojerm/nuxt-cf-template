// The template's own lifecycle steps. A fork adds its own in lifecycle-app-steps.ts
// (shipped empty, never edited by the template) — typically a win-back keyed on
// whatever "used the product" means there, which the template cannot know.

import { and, gt, lte, notExists, sql } from 'drizzle-orm'

import * as tables from '../db/schema'
import { activationNudgeEmail } from './lifecycle-emails'
import type { LifecycleDb, LifecycleRecipient, LifecycleStep } from './lifecycle'

const DAY_MS = 24 * 60 * 60 * 1000

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
 * Steps core owns. Features add theirs with registerLifecycleStep() (billing's
 * `pass_expiring`), which the task runs after these and before the app's.
 */
export const TEMPLATE_LIFECYCLE_STEPS: readonly LifecycleStep[] = [activationNudgeStep]
