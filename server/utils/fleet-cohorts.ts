// Weekly signup cohorts for /api/fleet: the funnel's three steps, per signup week.
//
// The 28-day funnel says how the product converts; it cannot say whether last
// week was better than the one before. A growth bet runs for a week or two, so
// its verdict needs the same three numbers cut by the week the user signed up.
//
// ── Calendar weeks, not rolling ones ────────────────────────────────────────
// Weeks start Monday 00:00 UTC. A rolling seven-day bucket would move with
// every poll, and two readers an hour apart would disagree about "week 3".
// The newest entry is the week in progress, so it is partial until Sunday.
//
// Same definitions as fleet-funnel.ts: every step counts users who signed up
// in that week, whenever they activated or paid.

import { and, count, countDistinct, eq, gte, lt, sql } from 'drizzle-orm'

import * as tables from '../db/schema'
import { getFunnelStageContributor } from './extensions'
import type { FleetDb } from './fleet-status'

export const COHORT_WEEKS = 8

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export interface FleetCohortWeek {
  /** The Monday the week starts on, `YYYY-MM-DD` (UTC). */
  weekStart: string
  signups: number
  activated: number
  /** Counted by the billing feature's funnel contributor; 0 without it. */
  paid: number
}

/** Monday 00:00 UTC of the week `at` falls in. */
export function weekStartUtc(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const daysSinceMonday = (at.getUTCDay() + 6) % 7
  return new Date(midnight - daysSinceMonday * DAY_MS)
}

/** Always COHORT_WEEKS entries, oldest first, zeros for a week with no signups. */
export async function collectFleetWeeks(db: FleetDb, now = new Date()): Promise<FleetCohortWeek[]> {
  const first = new Date(weekStartUtc(now).getTime() - (COHORT_WEEKS - 1) * WEEK_MS)
  const starts = Array.from(
    { length: COHORT_WEEKS },
    (_, index) => new Date(first.getTime() + index * WEEK_MS),
  )

  // `created_at` is unix seconds. The cast makes the division integral whatever
  // type D1 binds the two numbers as.
  const week = sql<number>`cast((${tables.users.createdAt} - ${first.getTime() / 1000}) / ${WEEK_MS / 1000} as integer)`
  const inWindow = gte(tables.users.createdAt, first)

  const signupRows = await db
    .select({ week, total: count() })
    .from(tables.users)
    .where(inWindow)
    .groupBy(week)

  const activatedRows = await db
    .select({ week, total: countDistinct(tables.auditLog.actorUserId) })
    .from(tables.auditLog)
    .innerJoin(tables.users, eq(tables.users.id, tables.auditLog.actorUserId))
    .where(and(eq(tables.auditLog.action, 'onboarding.activated'), inWindow))
    .groupBy(week)

  // The contributor takes a cohort subquery, so `paid` is one count per week.
  const contributor = getFunnelStageContributor('paid')
  const paid = contributor
    ? await Promise.all(
        starts.map((start) =>
          contributor.count(
            db,
            db
              .select({ id: tables.users.id })
              .from(tables.users)
              .where(
                and(
                  gte(tables.users.createdAt, start),
                  lt(tables.users.createdAt, new Date(start.getTime() + WEEK_MS)),
                ),
              ),
          ),
        ),
      )
    : []

  const signups = byWeek(signupRows)
  const activated = byWeek(activatedRows)
  return starts.map((start, index) => ({
    weekStart: start.toISOString().slice(0, 10),
    signups: signups.get(index) ?? 0,
    activated: activated.get(index) ?? 0,
    paid: paid[index] ?? 0,
  }))
}

function byWeek(rows: { week: number; total: number }[]): Map<number, number> {
  return new Map(rows.map((row) => [Number(row.week), row.total]))
}
