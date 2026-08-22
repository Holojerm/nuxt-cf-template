// Audit trail — the append-only record of privileged actions.
//
// Like server/utils/entitlements.ts, every function here takes the Drizzle
// client as its first argument rather than reaching for the auto-imported `db`,
// so test/audit.test.ts can drive it against a real D1 binding inside workerd
// without booting Nitro. The H3-facing helper at the bottom is the exception,
// and it is the only thing in this file a test can't call.
//
// ── Policy: audit before act ─────────────────────────────────────────────────
// The audit row is written BEFORE the privileged action runs, and a failed
// audit write fails the action. This is the whole reason `withAudit()` exists
// rather than a pair of calls a handler is trusted to order correctly.
//
// The alternative — act first, then record, and swallow a failed insert the way
// sendEmail() swallows a failed send — is the wrong trade here, and the two
// cases are worth separating because they look similar:
//
//   - A dropped email is a customer inconvenience. The money event behind it
//     already happened and is still in the database. Failing the webhook to
//     save the email would make Paddle replay a payment.
//   - A dropped audit row is the *disappearance of the only evidence* that an
//     admin reached into someone else's account. Nothing else records it. An
//     entitlement appears in a customer's billing history with no explanation,
//     and there is no query that recovers who did it or why.
//
// So: an unrecorded privileged action is strictly worse than a refused one.
// A refused grant is visible immediately — the admin sees an error and retries.
// An unrecorded grant is invisible forever. This is the same reasoning the
// `audit_log` table comment gives for having no foreign key and no updated_at:
// the write must not fail for an incidental reason, and the row must not be
// editable afterwards. Everything here is in service of "the record is true".
//
// The cost is real and accepted: D1 being down takes the admin console's
// mutations down with it. D1 being down has already taken the rest of the app
// down, so the marginal loss is small.
//
// ── What this means for metadata ─────────────────────────────────────────────
// Because the row is written first, its metadata describes the *intent*, not
// the outcome — "grant 2 passes to user X, because Y", not "user X now expires
// on Z". Anything the action computes is not available yet, and deliberately so:
// a row that could be corrected after the fact is a row that can be corrected
// after the fact. The resulting state lives in the table the action wrote to;
// this one answers "who decided, and what did they decide".
//
// ── What does NOT go in metadata ─────────────────────────────────────────────
// Personal data that `target_id` already points at — an email address above all.
// This table is append-only and has no retention job, so anything written here
// outlives the account it describes. /account promises we will "remove the
// account and everything attached to it", and an email frozen into an
// undeletable row makes that promise false in a way nobody would notice.
//
// The id is the durable identifier and the email is a *display* concern, so it
// is resolved at read time by joining `users` (see server/api/admin/audit.get.ts).
// The join returns null once the account is gone, which is the correct answer
// rather than a stale one. Storing it would also have meant the console relying
// on client-side filtering to keep it off the screen — a display detail standing
// in for a storage decision.
//
// `admin.user_searched` looks like an exception and is not one. Its metadata
// keeps the search needle — because "who did this admin go looking for" is the
// entire reason to audit a search — but as a SALTED HASH, never the address
// itself. An investigator who suspects a value can hash it and compare; nobody
// can read an email back out of the table. Same discipline, applied to a field
// that genuinely has to survive.

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type { H3Event } from 'h3'
import * as tables from '../db/schema'
import type { AuditLogEntry, AuditMetadata } from '../db/schema'
import { hashIp } from './feedback'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type AuditDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * Every action this app records, as a closed union.
 *
 * Closed rather than free text for the same reason FEEDBACK_KINDS is: a typo'd
 * action name doesn't fail anything, it just quietly splits the trail into two
 * buckets, and you find out when the one query this table exists to serve comes
 * back short. Adding an action is one line here.
 *
 * Naming: past tense, namespaced by surface. `admin.*` is a human acting on
 * someone else's data through the console. `account.*` is a signed-in person
 * acting on their own account — actorUserId and targetId are the same id.
 */
export const AUDIT_ACTIONS = [
  /** An admin searched the user directory by email. Records the needle. */
  'admin.user_searched',
  /** An admin opened one user's detail page — identity, billing, feedback. */
  'admin.user_viewed',
  /** An admin rendered a read-only "view as" of what a user would see. */
  'admin.user_viewed_as',
  /** An admin granted comp access (the apology grant). */
  'admin.pass_granted',
  /** An admin took comp access back. The inverse of the line above. */
  'admin.pass_revoked',
  /** An admin moved a feedback row through triage. */
  'feedback.status_changed',
  /**
   * An admin sent a customer an email. The most consequential thing in this
   * list: it leaves the building under the company's name and cannot be
   * recalled, so it was the conspicuous gap while merely *reading* a customer's
   * record was already audited.
   */
  'feedback.replied',
  /**
   * A person deleted their own account through self-serve /account —
   * `actorType: 'user'`, the one action in this list nobody but the account's
   * own owner can take. `metadata` carries row counts only (see
   * server/utils/account.ts) — the whole point of this row is to survive the
   * account it describes, so nothing that identifies the person may live here.
   */
  'account.deleted',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** What gets recorded. Only `actorUserId` and `action` are ever required. */
export interface AuditEntry {
  /**
   * The user id behind the action. Not a foreign key (see the table comment) —
   * for `actorType: 'system'` this is a sentinel like `system` rather than a row.
   */
  actorUserId: string
  actorType?: 'admin' | 'system' | 'user'
  action: AuditAction
  /** What was acted on — 'user', 'feedback', 'entitlement'. Null for bulk reads. */
  targetType?: string | null
  targetId?: string | null
  /** Flat scalars only — see AuditMetadata in server/db/schema.ts for why. */
  metadata?: AuditMetadata | null
  /** Salted SHA-256 of the caller's IP; use auditIpHash(event) to build it. */
  ipHash?: string | null
}

/**
 * Append one row. Throws if the insert fails — callers must not catch it, which
 * is what `withAudit()` below exists to make hard to get wrong.
 */
export async function writeAudit(db: AuditDb, entry: AuditEntry): Promise<AuditLogEntry> {
  const [row] = await db
    .insert(tables.auditLog)
    .values({
      actorUserId: entry.actorUserId,
      actorType: entry.actorType ?? 'admin',
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      ipHash: entry.ipHash ?? null,
    })
    .returning()

  // A silent no-op insert would be indistinguishable from a recorded action, so
  // it gets the same treatment as a thrown error rather than a warning.
  if (!row) throw new Error('audit insert returned no row')
  return row
}

/**
 * Run a privileged action behind its audit row — the executable form of the
 * policy at the top of this file.
 *
 * `act` runs only if the audit row landed. Nothing here catches: an audit
 * failure propagates to the handler as a 500, the action never happens, and
 * the admin sees an error instead of a silent success.
 *
 *   return withAudit(db, { actorUserId: admin.id, action: 'admin.pass_granted', … },
 *     () => grantCompPasses(db, { … }))
 *
 * Reads go through it too, not just mutations. Looking up a customer's email,
 * billing history, and support tickets is a privileged read of another person's
 * data; that it changes nothing does not make it unremarkable.
 */
export async function withAudit<T>(
  db: AuditDb,
  entry: AuditEntry,
  act: () => Promise<T>,
): Promise<T> {
  await writeAudit(db, entry)
  // `return await`, not `return`. Returning the promise bare makes an async
  // function adopt it a microtask later, which leaves a rejecting action
  // momentarily unhandled — workerd reports that as an unhandled rejection even
  // though the caller does catch it. Awaiting attaches the handler in the same
  // tick, so a failed action logs once, as itself.
  return await act()
}

export interface ListAuditOptions {
  /** Everything one admin did — the index the table carries. */
  actorUserId?: string
  targetType?: string
  /** Everything done TO one subject, which is the support-facing question. */
  targetId?: string
  limit?: number
}

/** Newest-first audit rows for the console. Capped; this table only grows. */
export async function listAudit(
  db: AuditDb,
  options: ListAuditOptions = {},
): Promise<AuditLogEntry[]> {
  const filters = [
    options.actorUserId ? eq(tables.auditLog.actorUserId, options.actorUserId) : undefined,
    options.targetType ? eq(tables.auditLog.targetType, options.targetType) : undefined,
    options.targetId ? eq(tables.auditLog.targetId, options.targetId) : undefined,
  ].filter((f) => f !== undefined)

  return db
    .select()
    .from(tables.auditLog)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(tables.auditLog.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
}

/**
 * Resolve the email address behind each `user` target, for display only.
 *
 * Lives here rather than in the endpoint so it can be tested: the chunking
 * below is the kind of thing that works on every fixture anyone writes by hand
 * and fails on a real page of audit rows.
 *
 * `inArray` expands to one bound parameter per id, and D1 caps a statement at
 * 100 bound parameters. `listAudit` returns up to 200 rows, so a page touching
 * mostly distinct users would exceed that — a runtime error on the console's
 * busiest screen, invisible to the type checker.
 *
 * A missing id simply has no entry: the account was deleted, and falling back
 * to the raw id is the honest answer rather than a stale one.
 */
export async function resolveAuditSubjectEmails(
  db: AuditDb,
  rows: readonly AuditLogEntry[],
): Promise<Map<string, string>> {
  const subjectIds = [
    ...new Set(
      rows
        .filter((row) => row.targetType === 'user' && row.targetId)
        .map((row) => row.targetId as string),
    ),
  ]

  const CHUNK = 100
  const emailById = new Map<string, string>()
  for (let index = 0; index < subjectIds.length; index += CHUNK) {
    const found = await db
      .select({ id: tables.users.id, email: tables.users.email })
      .from(tables.users)
      .where(inArray(tables.users.id, subjectIds.slice(index, index + CHUNK)))
    for (const subject of found) emailById.set(subject.id, subject.email)
  }
  return emailById
}

/** The wire shape of an audit row — dates as ISO strings, for the console. */
export interface AuditView {
  id: string
  actorUserId: string
  actorType: string
  action: string
  targetType: string | null
  targetId: string | null
  metadata: AuditMetadata | null
  createdAt: string
}

export function toAuditView(row: AuditLogEntry): AuditView {
  // `ip_hash` is deliberately not on the wire. It is an investigation aid for
  // someone with database access, not something the console needs to render,
  // and shipping it to a browser makes an opaque identifier one screenshot away
  // from being pasted into a ticket.
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorType: row.actorType,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  }
}

// ─── H3-facing ───────────────────────────────────────────────────────────────

/**
 * Salted hash of the caller's IP for an audit row, built exactly the way
 * server/api/feedback.post.ts builds the one on a feedback row — same salt,
 * same construction, so the two are comparable in an investigation and neither
 * is an identifier on its own.
 */
export async function auditIpHash(event: H3Event): Promise<string | null> {
  const ip = getHeader(event, 'cf-connecting-ip') ?? getRequestIP(event, { xForwardedFor: true })
  return hashIp(ip, useRuntimeConfig(event).sessionPassword)
}
