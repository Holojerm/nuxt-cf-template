// The signup funnel, counted from D1 for /api/fleet.
//
// ── Why D1 and not PostHog ──────────────────────────────────────────────────
// PostHog has the richer funnel, but it loses the visitors who block it, and
// those are not a random sample. Signups, activation (the `onboarding.activated`
// audit row) and payment (an `entitlements` row) are all first-party facts in
// this database, so the dashboard gets a funnel that exists even for an app
// with no PostHog project yet, and that agrees with the money.
//
// ── Cohort, not calendar ────────────────────────────────────────────────────
// Every step counts users who SIGNED UP in the window, so the three numbers
// are a funnel (each ≤ the one before) rather than three unrelated tallies.
// A user who signed up 40 days ago and paid yesterday is not in it; that is
// what makes "activated / signups" a rate.

import { and, count, countDistinct, desc, eq, gt, inArray, or, like, sql } from 'drizzle-orm'

import * as tables from '../db/schema'
import type { FleetDb } from './fleet-status'

export const FUNNEL_COHORT_DAYS = 28
/** Enough to see which channel works; more is a table, not a card. */
export const FUNNEL_TOP_SOURCES = 5

const DAY_MS = 24 * 60 * 60 * 1000

export interface FleetFunnel {
  cohortDays: number
  signups: number
  activated: number
  /** Bought something. Comps and referral grants are access nobody paid for. */
  paid: number
  /** Signups by first-touch source, top few; `direct` when none was recorded. */
  sources: Record<string, number>
}

export async function collectFleetFunnel(db: FleetDb, now = new Date()): Promise<FleetFunnel> {
  const since = new Date(now.getTime() - FUNNEL_COHORT_DAYS * DAY_MS)
  const cohort = db
    .select({ id: tables.users.id })
    .from(tables.users)
    .where(gt(tables.users.createdAt, since))

  const [signups] = await db
    .select({ total: count() })
    .from(tables.users)
    .where(gt(tables.users.createdAt, since))

  const [activated] = await db
    .select({ total: countDistinct(tables.auditLog.actorUserId) })
    .from(tables.auditLog)
    .where(
      and(
        eq(tables.auditLog.action, 'onboarding.activated'),
        inArray(tables.auditLog.actorUserId, cohort),
      ),
    )

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

  const source = sql<string | null>`lower(${tables.users.signupSource})`
  const sourceRows = await db
    .select({ source, total: count() })
    .from(tables.users)
    .where(gt(tables.users.createdAt, since))
    .groupBy(source)
    .orderBy(desc(count()))
    .limit(FUNNEL_TOP_SOURCES)

  const sources: Record<string, number> = {}
  for (const row of sourceRows) {
    const key = sourceKey(row.source)
    sources[key] = (sources[key] ?? 0) + row.total
  }

  return {
    cohortDays: FUNNEL_COHORT_DAYS,
    signups: signups?.total ?? 0,
    activated: activated?.total ?? 0,
    paid: paid?.total ?? 0,
    sources,
  }
}

/**
 * `utm_source` is whatever a link said, up to 100 characters, and this payload
 * is stored in another app's database. Only a short slug survives; anything
 * else is bucketed rather than passed through.
 */
export function sourceKey(raw: string | null): string {
  if (!raw) return 'direct'
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw) ? raw : 'other'
}
