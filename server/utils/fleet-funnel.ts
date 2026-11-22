// The signup funnel, counted from D1 for /api/fleet.
//
// ── Why D1 and not PostHog ──────────────────────────────────────────────────
// PostHog has the richer funnel, but it loses the visitors who block it, and
// those are not a random sample. Signups, activation (the `onboarding.activated`
// audit row) and payment (a billing entitlement) are all first-party facts in
// this database, so the dashboard gets a funnel that exists even for an app
// with no PostHog project yet, and that agrees with the money.
//
// ── Cohort, not calendar ────────────────────────────────────────────────────
// Every step counts users who SIGNED UP in the window, so the three numbers
// are a funnel (each ≤ the one before) rather than three unrelated tallies.
// A user who signed up 40 days ago and paid yesterday is not in it; that is
// what makes "activated / signups" a rate.

import { and, count, countDistinct, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { LANDING_MAX, LANDING_PATTERN } from '#shared/utils/landing-path'

import * as tables from '../db/schema'
import { getFunnelStageContributor } from './extensions'
import { collectFleetWeeks, type FleetCohortWeek } from './fleet-cohorts'
import type { FleetDb } from './fleet-status'

export const FUNNEL_COHORT_DAYS = 28
/** Enough to see which channel works; more is a table, not a card. */
export const FUNNEL_TOP_SOURCES = 5
/** Landing pages and campaigns are what a growth bet is judged on, so a few more. */
export const FUNNEL_TOP_LANDINGS = 10
export const FUNNEL_TOP_CAMPAIGNS = 10

const DAY_MS = 24 * 60 * 60 * 1000
const SLUG = /^[a-z0-9][a-z0-9._-]{0,39}$/

export interface FleetFunnel {
  cohortDays: number
  signups: number
  activated: number
  /**
   * Bought something. Comps and referral grants are access nobody paid for.
   * Counted by the billing feature's funnel contributor; 0 without it.
   */
  paid: number
  /** Signups by first-touch source, top few; `direct` when none was recorded. */
  sources: Record<string, number>
  /**
   * Signups by first-touch landing path, top few. `unknown` when none was
   * recorded: accounts older than the column, or a visitor with no cookie.
   */
  landings: Record<string, number>
  /** Signups by `utm_campaign`, top few; users with no campaign are left out. */
  campaigns: Record<string, number>
  /** The same three steps per signup week, oldest first (fleet-cohorts.ts). */
  weeks: FleetCohortWeek[]
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

  // Only a feature knows what "paid" means (billing counts Stripe-minted
  // entitlements); with none registered the stage reads 0 and the shape holds.
  const paid = (await getFunnelStageContributor('paid')?.count(db, cohort)) ?? 0

  const inCohort = gt(tables.users.createdAt, since)
  const campaign = sql<string | null>`lower(${tables.users.signupCampaign})`

  return {
    cohortDays: FUNNEL_COHORT_DAYS,
    signups: signups?.total ?? 0,
    activated: activated?.total ?? 0,
    paid,
    sources: await signupsBy(
      db,
      sql<string | null>`lower(${tables.users.signupSource})`,
      inCohort,
      FUNNEL_TOP_SOURCES,
      sourceKey,
    ),
    landings: await signupsBy(
      db,
      sql<string | null>`${tables.users.signupLanding}`,
      inCohort,
      FUNNEL_TOP_LANDINGS,
      landingKey,
    ),
    campaigns: await signupsBy(
      db,
      campaign,
      and(inCohort, isNotNull(tables.users.signupCampaign)),
      FUNNEL_TOP_CAMPAIGNS,
      campaignKey,
    ),
    weeks: await collectFleetWeeks(db, now),
  }
}

/** Signups grouped by one first-touch column: the top `limit` groups, re-keyed. */
async function signupsBy(
  db: FleetDb,
  column: SQL<string | null>,
  where: SQL | undefined,
  limit: number,
  toKey: (raw: string | null) => string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ value: column, total: count() })
    .from(tables.users)
    .where(where)
    .groupBy(column)
    .orderBy(desc(count()))
    .limit(limit)

  const result: Record<string, number> = {}
  for (const row of rows) {
    const key = toKey(row.value)
    result[key] = (result[key] ?? 0) + row.total
  }
  return result
}

/**
 * `utm_source` is whatever a link said, up to 100 characters, and this payload
 * is stored in another app's database. Only a short slug survives; anything
 * else is bucketed rather than passed through.
 */
export function sourceKey(raw: string | null): string {
  if (!raw) return 'direct'
  return SLUG.test(raw) ? raw : 'other'
}

/** Same rule as sourceKey for `utm_campaign`; the query never passes null. */
export function campaignKey(raw: string | null): string {
  return raw && SLUG.test(raw) ? raw : 'other'
}

/**
 * The stored value is already a route shape (shared/utils/landing-path.ts);
 * this re-checks it on the way out, since the column is also written from a
 * cookie.
 */
export function landingKey(raw: string | null): string {
  if (!raw) return 'unknown'
  return raw.length <= LANDING_MAX && LANDING_PATTERN.test(raw) ? raw : 'other'
}
