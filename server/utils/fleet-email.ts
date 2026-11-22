// What the product mailed, for /api/fleet: sends per step, and who is listening.
//
// Counted from the two ledgers a send is claimed in: `lifecycle_sends` for
// accounts (server/utils/lifecycle.ts, server/utils/announcements.ts) and
// `subscriber_sends` for visitors who subscribed without one. An announcement
// appears as the step `announcement.<id>`, summed over both. Sign-in links,
// receipts and the subscribe confirmation are in neither table and are not
// counted: this answers "what did the product send to bring people back", which
// is what an email bet is judged on. Counts only; no recipients, no addresses.

import { count, gt, sum } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { FleetDb } from './fleet-status'
import { countSubscribers } from './subscribers'

export const EMAIL_WINDOW_DAYS = 28
/** Step ids are a small closed set in code; the cap is for a runaway fork. */
export const EMAIL_STEP_LIMIT = 20

const DAY_MS = 24 * 60 * 60 * 1000

export interface FleetEmail {
  windowDays: number
  /** Every send in the window, including steps past the cap. */
  sent: number
  /** Sends by step id, busiest first. */
  steps: Record<string, number>
  /** Announcement sends skipped by the weekly cap, for runs started in the window. */
  capped: number
  /** Visitors on the product-updates list. `pending` have not confirmed and get no mail. */
  subscribers: { confirmed: number; pending: number }
}

export async function collectFleetEmail(db: FleetDb, now = new Date()): Promise<FleetEmail> {
  const since = new Date(now.getTime() - EMAIL_WINDOW_DAYS * DAY_MS)
  const accounts = tables.lifecycleSends
  const visitors = tables.subscriberSends

  const rows = [
    ...(await db
      .select({ stepId: accounts.stepId, total: count() })
      .from(accounts)
      .where(gt(accounts.sentAt, since))
      .groupBy(accounts.stepId)),
    ...(await db
      .select({ stepId: visitors.stepId, total: count() })
      .from(visitors)
      .where(gt(visitors.sentAt, since))
      .groupBy(visitors.stepId)),
  ]

  const totals = new Map<string, number>()
  let sent = 0
  for (const row of rows) {
    const key = stepKey(row.stepId)
    totals.set(key, (totals.get(key) ?? 0) + row.total)
    sent += row.total
  }
  const busiest = [...totals].sort((a, b) => b[1] - a[1]).slice(0, EMAIL_STEP_LIMIT)

  const [capped] = await db
    .select({ total: sum(tables.announcementRuns.capped) })
    .from(tables.announcementRuns)
    .where(gt(tables.announcementRuns.createdAt, since))

  return {
    windowDays: EMAIL_WINDOW_DAYS,
    sent,
    steps: Object.fromEntries(busiest),
    capped: Number(capped?.total ?? 0),
    subscribers: await countSubscribers(db),
  }
}

/** Step ids are identifiers written by code; anything else is bucketed. */
export function stepKey(raw: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(raw) ? raw : 'other'
}
