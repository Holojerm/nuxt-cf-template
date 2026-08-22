// Ops alerting — the "you find out from an alert, not from a user" path.
//
// Why this exists at all: Cloudflare cannot alert on Worker logs. Workers Logs
// is queryable but has no notification hook, Log Explorer carries HTTP
// requests and not `workers_trace_events`, and the Notifications catalogue has
// no usable Workers entry. So the only component that both knows a request
// failed and can do something about it is the Worker itself. It writes a row
// here; a cron (server/tasks/ops/alert.ts) drains the rows and emails a
// digest.
//
// Back-ported from a fork that ran it in production for a while; the one
// change is that the digest no longer hardcodes the product's name.
//
// Like server/utils/purge.ts, every function takes the Drizzle client
// explicitly so the workerd suite can drive it against a real D1 binding.

import { and, asc, inArray, isNull, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
import type { OpsEvent } from '../db/schema'

export type OpsDb = ReturnType<typeof drizzle<typeof tables>>

/** How long drained rows stick around before the cron prunes them. */
export const OPS_EVENT_RETENTION_DAYS = 7

/**
 * Most rows one digest will carry. A single bad deploy can produce thousands of
 * identical errors; the email needs to say "your app is broken", not transcribe
 * every instance. Counts still reflect everything drained.
 */
export const OPS_DIGEST_SAMPLE_LIMIT = 200

const DAY_MS = 24 * 60 * 60 * 1000

export interface OpsEventInput {
  kind: string
  detail?: string | null
  path?: string | null
}

/**
 * Spool an event for the next digest. Best-effort by design: this runs inside
 * error handling, and an alerting failure must never become the user's problem.
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
    console.error(JSON.stringify({ kind: 'ops_event_write_failed', error: String(err) }))
  }
}

export interface OpsDigestOptions {
  /** Leads the subject line — the product's display name. */
  appName: string
  /** The app Worker's name, for the Observability deep link. Omit to skip the link. */
  workerName?: string
  now?: Date
}

export interface OpsDigest {
  subject: string
  text: string
  /** Rows this digest accounts for — the ones to mark notified. */
  ids: string[]
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Turn spooled rows into an email. Pure — no db, no network — so the wording
 * and the grouping are testable without a transport.
 */
export function buildOpsDigest(rows: OpsEvent[], options: OpsDigestOptions): OpsDigest | null {
  if (rows.length === 0) return null
  const now = options.now ?? new Date()

  const byKind = new Map<string, OpsEvent[]>()
  for (const row of rows) {
    const bucket = byKind.get(row.kind)
    if (bucket) bucket.push(row)
    else byKind.set(row.kind, [row])
  }

  // Loudest kind first — that's the headline.
  const kinds = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)
  const [topKind, topRows] = kinds[0]!

  const subject =
    kinds.length === 1
      ? `${options.appName}: ${pluralize(topRows.length, topKind)}`
      : `${options.appName}: ${pluralize(rows.length, 'event')} across ${kinds.length} kinds (${topKind} loudest)`

  const oldest = rows.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt

  const lines: string[] = [
    `${rows.length} unreported event${rows.length === 1 ? '' : 's'} since ${oldest.toISOString()}.`,
    '',
  ]

  for (const [kind, kindRows] of kinds) {
    lines.push(`${kind} — ${kindRows.length}`)
    // Three examples is enough to tell "one broken route" from "everything".
    for (const row of kindRows.slice(0, 3)) {
      const where = row.path ? ` ${row.path}` : ''
      const what = row.detail ? ` — ${row.detail}` : ''
      lines.push(`  ${row.createdAt.toISOString()}${where}${what}`)
    }
    if (kindRows.length > 3) lines.push(`  …and ${kindRows.length - 3} more`)
    lines.push('')
  }

  if (options.workerName) {
    lines.push(
      `Logs: https://dash.cloudflare.com/?to=/:account/workers/services/view/${options.workerName}/production/observability`,
    )
  }
  lines.push('Runbook: README.md › Ops alerting', `Generated ${now.toISOString()}`)

  return { subject, text: lines.join('\n'), ids: rows.map((r) => r.id) }
}

/** Transport for the digest. Injected so tests never touch the mail binding. */
export type OpsMailer = (digest: OpsDigest) => Promise<void>

export interface DrainResult {
  /** Rows found waiting (capped at OPS_DIGEST_SAMPLE_LIMIT). */
  pending: number
  /** True when a digest was handed to the mailer and accepted. */
  sent: boolean
  /** Rows deleted by the retention sweep. */
  pruned: number
  error?: string
}

/**
 * One cron tick: drain, notify, prune.
 *
 * Rows are marked notified only after the mailer resolves. If sending fails the
 * rows stay pending and the next tick retries — an alerting system that loses
 * the alert when the mail hiccups is worse than no alerting system, because it
 * lies about coverage.
 */
export async function drainOpsEvents(
  db: OpsDb,
  mail: OpsMailer,
  options: OpsDigestOptions,
): Promise<DrainResult> {
  const now = options.now ?? new Date()

  const pending = await db
    .select()
    .from(tables.opsEvents)
    .where(isNull(tables.opsEvents.notifiedAt))
    .orderBy(asc(tables.opsEvents.createdAt))
    .limit(OPS_DIGEST_SAMPLE_LIMIT)

  let sent = false
  let error: string | undefined

  const digest = buildOpsDigest(pending, { ...options, now })
  if (digest) {
    try {
      await mail(digest)
      sent = true
      // Chunked so a large drain can't build a SQL statement D1 will reject.
      for (let i = 0; i < digest.ids.length; i += 50) {
        const chunk = digest.ids.slice(i, i + 50)
        await db
          .update(tables.opsEvents)
          .set({ notifiedAt: now })
          .where(and(isNull(tables.opsEvents.notifiedAt), inArray(tables.opsEvents.id, chunk)))
      }
    } catch (err) {
      error = String(err)
      console.error(JSON.stringify({ kind: 'ops_alert_send_failed', error }))
    }
  }

  const cutoff = new Date(now.getTime() - OPS_EVENT_RETENTION_DAYS * DAY_MS)
  const pruned = await db
    .delete(tables.opsEvents)
    .where(lt(tables.opsEvents.createdAt, cutoff))
    .returning({ id: tables.opsEvents.id })

  return { pending: pending.length, sent, pruned: pruned.length, error }
}
