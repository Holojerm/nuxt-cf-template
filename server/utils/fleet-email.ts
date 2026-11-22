// What the product mailed, for /api/fleet: lifecycle sends per step.
//
// Counted from `lifecycle_sends`, the ledger the lifecycle task writes one row
// to per message (server/utils/lifecycle.ts). Sign-in links and receipts are
// not in that table and are not counted here: this answers "what did the
// product send to bring people back", which is what an email bet is judged on.
// Counts only; no recipients, no addresses.

import { count, desc, gt } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { FleetDb } from './fleet-status'

export const EMAIL_WINDOW_DAYS = 28
/** Step ids are a small closed set in code; the cap is for a runaway fork. */
export const EMAIL_STEP_LIMIT = 20

const DAY_MS = 24 * 60 * 60 * 1000

export interface FleetEmail {
  windowDays: number
  /** Every lifecycle send in the window, including steps past the cap. */
  sent: number
  /** Sends by step id, busiest first. */
  steps: Record<string, number>
}

export async function collectFleetEmail(db: FleetDb, now = new Date()): Promise<FleetEmail> {
  const inWindow = gt(
    tables.lifecycleSends.sentAt,
    new Date(now.getTime() - EMAIL_WINDOW_DAYS * DAY_MS),
  )

  const [sent] = await db.select({ total: count() }).from(tables.lifecycleSends).where(inWindow)

  const rows = await db
    .select({ stepId: tables.lifecycleSends.stepId, total: count() })
    .from(tables.lifecycleSends)
    .where(inWindow)
    .groupBy(tables.lifecycleSends.stepId)
    .orderBy(desc(count()))
    .limit(EMAIL_STEP_LIMIT)

  const steps: Record<string, number> = {}
  for (const row of rows) {
    const key = stepKey(row.stepId)
    steps[key] = (steps[key] ?? 0) + row.total
  }

  return { windowDays: EMAIL_WINDOW_DAYS, sent: sent?.total ?? 0, steps }
}

/** Step ids are identifiers written by code; anything else is bucketed. */
export function stepKey(raw: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(raw) ? raw : 'other'
}
