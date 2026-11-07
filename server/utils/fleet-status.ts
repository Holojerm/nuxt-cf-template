// What /api/status and /api/fleet report, as functions that take the Drizzle
// client explicitly — the same split as server/utils/purge.ts, for the same
// reason: the workerd test suite can drive these against a real D1, and the
// two route handlers stay thin enough to have nothing in them worth testing.
//
// ── Migration drift ─────────────────────────────────────────────────────────
// The one signal here that has already cost an outage. `wrangler deploy` does
// not apply D1 migrations (AGENTS.md › Gotchas), so a push that adds a column
// goes live before the column exists, and stays that way until someone
// remembers `bun run db:migrate:remote`. On 2026-08-21 that gap was seven
// minutes of sign-in failing on a fork. Seven minutes is luck, not a bound.
//
// Nothing on the Worker can close the gap — it has no way to run migrations
// from a request — but it CAN say it is open, which is what /api/status does:
// the repo's journal is bundled into the Worker at build time, the applied list
// is a table in D1, and the difference is the set of migrations production has
// never seen. A poller that reads `pending` sees the outage the moment it
// starts rather than when a user reports it.
//
// Two tables, because two tools record migrations. `bun run db:migrate:remote`
// (wrangler) writes `d1_migrations`; the generated .output wrangler.json names
// `_hub_migrations` instead, and both work — which is exactly why this reads
// whichever one exists rather than assuming.

import { and, count, desc, eq, gt, max, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import journal from '../db/migrations/meta/_journal.json'
import * as tables from '../db/schema'
import { classifyOps, type OpsSeverity } from './ops-severity'
import { collectFleetFunnel, type FleetFunnel } from './fleet-funnel'
import {
  collectSections,
  getFleetCounterContributors,
  getFleetExtraContributors,
} from './extensions'
import type { FleetCounterContributor, FleetCounterSections } from './extensions'

/** Same shape as PurgeDb — the Drizzle client, passed in explicitly. */
export type FleetDb = ReturnType<typeof drizzle<typeof tables>>

/** Where a migration tool records what it applied, in the order they are tried. */
export const MIGRATION_TABLES = ['d1_migrations', '_hub_migrations'] as const
export type MigrationTable = (typeof MIGRATION_TABLES)[number]

/** Migration tags in the repository, oldest first, from drizzle-kit's journal. */
export function repoMigrations(): string[] {
  return journal.entries.map((entry) => entry.tag)
}

export interface AppliedMigrations {
  /** Which table answered, or null when neither exists — a database never migrated. */
  table: MigrationTable | null
  /** Migration names as recorded, oldest first. Wrangler stores the filename. */
  names: string[]
}

/**
 * What production has applied. Tries each known tracking table; a table that
 * does not exist is an error from D1, which is the expected case for the one
 * not in use, so it is caught and the next is tried. Any other failure is
 * also reported as "nothing applied" rather than thrown — this runs on a
 * public liveness route, and a liveness route that 500s on an unexpected
 * schema is measuring the wrong thing.
 */
export async function readAppliedMigrations(db: FleetDb): Promise<AppliedMigrations> {
  for (const table of MIGRATION_TABLES) {
    try {
      const rows = await db.all<{ name: string }>(
        sql`SELECT name FROM ${sql.identifier(table)} ORDER BY id`,
      )
      return { table, names: rows.map((row) => row.name) }
    } catch {
      // Not this table — try the next.
    }
  }
  return { table: null, names: [] }
}

export interface MigrationDrift {
  /** In the repo, never applied. Non-empty is the outage-in-waiting. */
  pending: string[]
  /** Applied, but not in the repo — a migration deleted or renamed after it shipped. */
  unknown: string[]
}

/**
 * Repo vs applied. Pure, so the rule is testable without a database.
 * Wrangler records `0003_name.sql` where the journal says `0003_name`; both
 * spellings are normalised to the tag.
 */
export function compareMigrations(repoTags: string[], appliedNames: string[]): MigrationDrift {
  const applied = new Set(appliedNames.map(tagOf))
  const repo = new Set(repoTags.map(tagOf))
  return {
    pending: [...repo].filter((tag) => !applied.has(tag)),
    unknown: [...applied].filter((tag) => !repo.has(tag)),
  }
}

function tagOf(name: string): string {
  return name.replace(/\.sql$/, '')
}

// ── Counters for /api/fleet ─────────────────────────────────────────────────
//
// Everything a portfolio dashboard wants to put on a card, in one query-light
// call. Counts, plus one summary line per ops kind — no ids, no emails, no
// stack traces — so the payload is safe to store for months in someone else's
// database. A fork adds its own (sessions
// run, plans created, …) by registering a contributor in server/utils/
// extensions.ts rather than editing this function or inventing a second
// endpoint, so one token and one route cover the fleet:
//   registerFleetExtraContributor    → plain numbers merged into `extra`
//   registerFleetCounterContributor  → a typed group beside `users`, `funnel`, …

const DAY_MS = 24 * 60 * 60 * 1000

/** Most kinds one response carries; a runaway kind namespace must not bloat it. */
export const FLEET_OPS_KIND_LIMIT = 50

export interface FleetOpsKind {
  kind: string
  severity: OpsSeverity
  /** Rows of this kind created in the last 24 h. */
  count: number
  /** ISO timestamp of the newest row of this kind. */
  lastAt: string
  /** That row's `detail`, already truncated to 500 characters at write time. */
  lastDetail: string | null
  lastPath: string | null
}

export interface FleetCountersCore {
  users: { total: number; last7d: number }
  ops: { kinds: FleetOpsKind[] }
  funnel: FleetFunnel
  extra: Record<string, number>
}

/** Core counters plus one group per registered feature (e.g. `feedback`). */
export type FleetCounters = FleetCountersCore & Partial<FleetCounterSections>

const SEVERITY_RANK: Record<OpsSeverity, number> = { critical: 0, warning: 1, info: 2 }

/**
 * The ops spool since `since`, one entry per kind: a GROUP BY for the counts,
 * then one lookup per kind for its newest row (at most FLEET_OPS_KIND_LIMIT,
 * and kinds are a small closed set in practice).
 */
async function collectOpsKinds(db: FleetDb, since: Date): Promise<{ kinds: FleetOpsKind[] }> {
  const grouped = await db
    .select({
      kind: tables.opsEvents.kind,
      total: count(),
      lastAt: max(tables.opsEvents.createdAt),
    })
    .from(tables.opsEvents)
    .where(gt(tables.opsEvents.createdAt, since))
    .groupBy(tables.opsEvents.kind)

  const ranked = grouped
    .map((g) => ({ ...g, severity: classifyOps(g.kind, g.total).severity }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.total - a.total)
    .slice(0, FLEET_OPS_KIND_LIMIT)

  const kinds = await Promise.all(
    ranked.map(async (g): Promise<FleetOpsKind> => {
      const [latest] = await db
        .select({
          createdAt: tables.opsEvents.createdAt,
          detail: tables.opsEvents.detail,
          path: tables.opsEvents.path,
        })
        .from(tables.opsEvents)
        .where(and(eq(tables.opsEvents.kind, g.kind), gt(tables.opsEvents.createdAt, since)))
        .orderBy(desc(tables.opsEvents.createdAt))
        .limit(1)
      return {
        kind: g.kind,
        severity: g.severity,
        count: g.total,
        lastAt: (latest?.createdAt ?? g.lastAt ?? since).toISOString(),
        lastDetail: latest?.detail ?? null,
        lastPath: latest?.path ?? null,
      }
    }),
  )
  return { kinds }
}

export async function collectFleetCounters(db: FleetDb, now = new Date()): Promise<FleetCounters> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS)
  const dayAgo = new Date(now.getTime() - DAY_MS)

  const [users] = await db.select({ total: count() }).from(tables.users)
  const [recentUsers] = await db
    .select({ total: count() })
    .from(tables.users)
    .where(gt(tables.users.createdAt, weekAgo))

  const ops = await collectOpsKinds(db, dayAgo)

  const extra: Record<string, number> = {}
  const extras = getFleetExtraContributors()
  const extraValues = await Promise.all(extras.map((c) => c.collect(db, now)))
  for (const values of extraValues) Object.assign(extra, values)

  return {
    users: { total: users?.total ?? 0, last7d: recentUsers?.total ?? 0 },
    ops,
    funnel: await collectFleetFunnel(db, now),
    extra,
    ...(await collectSections<FleetCounterContributor, FleetCounterSections>(
      getFleetCounterContributors(),
      (c) => c.collect(db, now),
    )),
  }
}
