// Audit trail — the append-only record of privileged actions.
//
// Every function takes the Drizzle client as its first argument rather than the
// auto-imported `db`, so test/audit.test.ts drives it against a real D1 binding
// in workerd without booting Nitro.
//
// Policy: audit before act. The row is written BEFORE the privileged action, and
// a failed audit write fails the action; `withAudit()` exists so a handler is
// not trusted to order a pair of calls. Unlike a dropped email (an inconvenience;
// failing the Paddle webhook to save it would replay a payment), a dropped audit
// row is the disappearance of the only evidence an admin reached into someone's
// account. An unrecorded action is worse than a refused one: a refusal is
// visible and retried. D1 being down already takes the app down, so the cost is
// small.
//
// Metadata describes intent ("grant 2 passes to X, because Y"), not outcome:
// the row is written first, and the resulting state lives in the table the action
// wrote to.
//
// Never put personal data that `target_id` already points at (an email above
// all) in metadata. The table is append-only with no retention job, so it would
// outlive the account and falsify /account's "remove everything attached". The
// id is durable; the email is resolved at read time by joining `users`
// (server/api/admin/audit.get.ts), returning null once the account is gone.
// `admin.user_searched` is the one exception that is not one: it keeps the
// search needle ("who did this admin look for" is the point of auditing it) as a
// SALTED HASH, which an investigator can match but nobody can read back.

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { AuditLogEntry, AuditMetadata } from '../db/schema'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type AuditDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * Every action this app records, as a closed union: a typo'd action name fails
 * nothing, it just splits the trail in two. Past tense, namespaced by surface:
 * `admin.*` is a human acting on someone else's data through the console,
 * `account.*` a signed-in person acting on their own (actorUserId == targetId).
 */
export const AUDIT_ACTIONS = [
  /** An admin searched the user directory by email. Records the needle (hashed). */
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
  /** An admin emailed a customer: it leaves under the company's name and cannot be recalled. */
  'feedback.replied',
  /**
   * A person deleted their own account (`actorType: 'user'`). `metadata` is row
   * counts only: this row must survive the account, so nothing identifying.
   */
  'account.deleted',
  /**
   * Deletion is about to ask Paddle to cancel a live subscription immediately.
   * Written BEFORE the call, so it records intent (a refused call leaves this row
   * and no `account.deleted`). Metadata: the `sub_` id only. Written by billing,
   * only with `billing.cancelOnDeletion` on.
   */
  'account.subscription_cancel_requested',
  /**
   * A person signed out everywhere. Records the `sessions_invalid_before`
   * watermark, otherwise invisible: cookies leave no rows.
   */
  'account.sessions_revoked',
  /**
   * The first-run checklist was observed complete, once. Not evidence like the
   * rest: it is the idempotency guard for the one-time `user_activated` PostHog
   * event (server/utils/onboarding.ts › hasActivated, recordActivationOnce).
   */
  'onboarding.activated',
  /**
   * The referral loop granted access nobody paid for (`actorType: 'system'`,
   * metadata `side: 'referee' | 'referrer'`). One action so "what has it given
   * away" is one query. Metadata: ids, days, entitlement ref; never a referral
   * code, a shareable credential.
   */
  'referral.rewarded',
  /**
   * A referral reward was clawed back (refund or chargeback). Its own action:
   * "given away" is a growth question, "taken back" a fraud one.
   */
  'referral.revoked',
  /** A clawed-back reward was put back because the chargeback was reversed. */
  'referral.restored',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** What gets recorded. Only `actorUserId` and `action` are ever required. */
export interface AuditEntry {
  /** The user id behind the action. Not a foreign key; a sentinel for `system`. */
  actorUserId: string
  actorType?: 'admin' | 'system' | 'user'
  action: AuditAction
  /** What was acted on — 'user', 'feedback', 'entitlement'. Null for bulk reads. */
  targetType?: string | null
  targetId?: string | null
  /** Flat scalars only — see AuditMetadata in server/db/schema.ts for why. */
  metadata?: AuditMetadata | null
  /** Salted SHA-256 of the caller's IP; use clientIpHash(event) to build it. */
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

  // A silent no-op insert looks like a recorded action; treat it as an error.
  if (!row) throw new Error('audit insert returned no row')
  return row
}

/**
 * Run a privileged action behind its audit row: `act` runs only if the row
 * landed, and nothing here catches, so an audit failure is a 500 and the action
 * never happens. Reads go through it too: looking up a customer is a privileged
 * read even though it changes nothing.
 *
 *   return withAudit(db, { actorUserId: admin.id, action: 'admin.pass_granted', … },
 *     () => grantCompPasses(db, { … }))
 */
export async function withAudit<T>(
  db: AuditDb,
  entry: AuditEntry,
  act: () => Promise<T>,
): Promise<T> {
  await writeAudit(db, entry)
  // `return await`: a bare promise is adopted a microtask later, leaving a
  // rejecting action briefly unhandled, which workerd reports.
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
 * Resolve the email behind each `user` target, for display only. D1 caps a
 * statement at 100 bound parameters and `listAudit` returns up to 200 rows, so
 * the lookup is chunked (passes every hand-written fixture, fails a real page).
 * A missing id has no entry: the account was deleted.
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
  // `ip_hash` stays off the wire: an investigation aid, not console content.
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
