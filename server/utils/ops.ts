// Ops spool — the "you find out from an alert, not from a user" path.
//
// Cloudflare cannot alert on Worker logs, so the only component that both knows
// a request failed and can do something about it is the Worker itself. It
// writes a row here and does nothing else: apps spool, the fleet dashboard
// alerts. The dashboard reads the per-kind summary from GET /api/fleet
// (server/utils/fleet-status.ts) and is the only thing that mails the owner.
// This file holds the writers, the 7-day retention sweep, and the raw read the
// ops-triage routine uses (GET /api/ops/events).
//
// Like server/utils/purge.ts, every function takes the Drizzle client
// explicitly so the workerd suite can drive it against a real D1 binding.

import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'

import { logEvent } from './log'

export type OpsDb = ReturnType<typeof drizzle<typeof tables>>

/** How long rows stick around before the daily purge prunes them. */
export const OPS_EVENT_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export interface OpsEventInput {
  kind: string
  detail?: string | null
  path?: string | null
}

/**
 * Spool an event for the fleet dashboard to pick up. Best-effort by design:
 * this runs inside error handling, and an alerting failure must never become
 * the user's problem.
 * A swallowed insert costs one alert; a thrown one costs the request.
 *
 * Callers must `await` this. Workers cancels promises still in flight once the
 * response is sent, so a fire-and-forget call on a path that immediately throws
 * loses the row — which is exactly the path this is here to record. Awaiting is
 * safe because this never rejects.
 */
export async function recordOpsEvent(db: OpsDb, input: OpsEventInput): Promise<void> {
  try {
    await db.insert(tables.opsEvents).values({
      kind: input.kind,
      detail: input.detail?.slice(0, 500) ?? null,
      path: input.path ?? null,
    })
  } catch (err) {
    logEvent('error', 'ops_event_write_failed', { error: String(err) })
  }
}

const lastUnauthenticatedRecord = new Map<string, number>()

/** At most one row per key per minute, per isolate. */
export const UNAUTHENTICATED_OPS_INTERVAL_MS = 60_000

/**
 * `recordOpsEvent` for a path anyone can hit without credentials, such as a
 * webhook rejecting a bad signature. Unthrottled, a script could write a D1 row
 * per request and wake the owner's alerts and the ops-triage routine at will.
 */
export async function recordUnauthenticatedOpsEvent(
  db: OpsDb,
  input: OpsEventInput,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${input.kind}|${input.detail ?? ''}`
  const last = lastUnauthenticatedRecord.get(key)
  if (last !== undefined && now - last < UNAUTHENTICATED_OPS_INTERVAL_MS) return false
  lastUnauthenticatedRecord.set(key, now)
  await recordOpsEvent(db, input)
  return true
}

/** Test-only. */
export function resetUnauthenticatedOpsThrottleForTest(): void {
  lastUnauthenticatedRecord.clear()
}

/**
 * Retention sweep, run by the daily purge task. Age-based, not delivery-based:
 * the dashboard reads the spool but never marks rows. Returns the number of
 * rows removed.
 */
export async function pruneOpsEvents(db: OpsDb, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OPS_EVENT_RETENTION_DAYS * DAY_MS)
  const pruned = await db
    .delete(tables.opsEvents)
    .where(lt(tables.opsEvents.createdAt, cutoff))
    .returning({ id: tables.opsEvents.id })
  return pruned.length
}

/** Most rows one read of the spool returns; retention caps the window at a week. */
export const OPS_EVENTS_READ_LIMIT = 500

export interface RecentOpsEvent {
  id: string
  kind: string
  detail: string | null
  path: string | null
  created_at: string
}

/**
 * The spool, newest first, for the ops-triage routine (GET /api/ops/events).
 */
export async function recentOpsEvents(
  db: OpsDb,
  options: { hours: number; kind?: string; now?: Date },
): Promise<RecentOpsEvent[]> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - options.hours * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(tables.opsEvents)
    .where(
      and(
        gte(tables.opsEvents.createdAt, since),
        options.kind ? eq(tables.opsEvents.kind, options.kind) : undefined,
      ),
    )
    .orderBy(desc(tables.opsEvents.createdAt))
    .limit(OPS_EVENTS_READ_LIMIT)
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    detail: r.detail,
    path: r.path,
    created_at: r.createdAt.toISOString(),
  }))
}
