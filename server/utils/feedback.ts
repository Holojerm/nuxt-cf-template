// Feedback capture — the "what did they say" half of the feedback loop.
// (PostHog, wired in app/plugins/posthog.client.ts, is the "what did they do"
// half. Both fire on every submission; see server/api/feedback.post.ts.)
//
// Like server/utils/entitlements.ts, every function takes the Drizzle client as
// its first argument rather than reaching for the auto-imported `db`, so the
// workerd vitest suite (test/feedback.test.ts) can drive it against a real D1
// binding without booting Nitro.

import { and, count, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { Feedback } from '../db/schema'
import { saltedHash } from './hash'
import { turnstileTokenSchema } from './turnstile'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type FeedbackDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * Submission types. Kept short on purpose — long taxonomies go untriaged.
 *
 * `churn` is the exception to "the widget sends everything": it comes from the
 * cancellation prompt on /account (app/utils/churn.ts), which is the only
 * chance to ask, because cancelling itself happens on Paddle's hosted portal
 * where no survey of ours can run.
 */
export const FEEDBACK_KINDS = ['bug', 'idea', 'praise', 'confusion', 'churn', 'other'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** Triage lifecycle. `triaged` means a human or routine has acted on it. */
export const FEEDBACK_STATUSES = ['new', 'triaged', 'closed'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

/** Anonymous POSTs are allowed, so the endpoint is rate-limited per IP hash. */
export const FEEDBACK_RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 }

const MESSAGE_MAX = 2000

/**
 * What a client may send. Everything identifying (user id, IP hash, user agent)
 * is derived server-side — never trusted from the body.
 */
export const feedbackSubmissionSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS).default('idea'),
  message: z.string().trim().min(3).max(MESSAGE_MAX),
  /** 1–5 satisfaction score, for programmatic prompts rather than the widget. */
  rating: z.number().int().min(1).max(5).nullish(),
  /** Reply-to address — only meaningful for signed-out submitters. */
  email: z.email().max(320).nullish(),
  path: z.string().max(512).nullish(),
  /** PostHog session replay deep link, from useFeedback() on the client. */
  replayUrl: z.string().max(1000).nullish(),
  posthogDistinctId: z.string().max(200).nullish(),
  /**
   * Solved Turnstile challenge, sent only by anonymous submitters and only when
   * a site key is configured. Nullish here rather than required because the
   * decision about whether it is *needed* belongs to the route (which knows
   * whether the submitter is signed in), not to the body shape — see
   * server/api/feedback.post.ts. Never stored: it is single-use and worthless
   * once verified.
   */
  turnstileToken: turnstileTokenSchema.nullish(),
})

export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>

/** Server-derived context attached to every row. */
export interface FeedbackContext {
  userId?: string | null
  ipHash?: string | null
  userAgent?: string | null
}

/**
 * Salted SHA-256 of the client IP. Salted with the session password so the
 * hashes are useless outside this deployment — they exist to count submissions
 * per source in an hour, nothing else.
 */
export async function hashIp(ip: string | undefined, salt: string): Promise<string | null> {
  // Delegates to the one implementation (server/utils/hash.ts) so this digest
  // and the audit trail's stay comparable — two copies of a salted hash is two
  // ways for the construction to drift apart.
  return saltedHash(ip, salt)
}

/** True when this source has already used up its hourly submission budget. */
export async function isRateLimited(
  db: FeedbackDb,
  ipHash: string | null,
  now = new Date(),
): Promise<boolean> {
  if (!ipHash) return false
  const since = new Date(now.getTime() - FEEDBACK_RATE_LIMIT.windowMs)
  const [row] = await db
    .select({ total: count() })
    .from(tables.feedback)
    .where(and(eq(tables.feedback.ipHash, ipHash), gt(tables.feedback.createdAt, since)))
  return (row?.total ?? 0) >= FEEDBACK_RATE_LIMIT.max
}

/** Insert one submission and return the stored row. */
export async function recordFeedback(
  db: FeedbackDb,
  input: FeedbackSubmission,
  context: FeedbackContext = {},
): Promise<Feedback> {
  const [row] = await db
    .insert(tables.feedback)
    .values({
      kind: input.kind,
      message: input.message,
      rating: input.rating ?? null,
      email: input.email ?? null,
      path: input.path ?? null,
      replayUrl: input.replayUrl ?? null,
      posthogDistinctId: input.posthogDistinctId ?? null,
      userId: context.userId ?? null,
      ipHash: context.ipHash ?? null,
      userAgent: context.userAgent?.slice(0, 256) ?? null,
    })
    .returning()
  if (!row) throw new Error('feedback insert returned no row')
  return row
}

export interface ListFeedbackOptions {
  status?: FeedbackStatus
  /** Only rows created after this instant — the triage watermark. */
  since?: Date
  limit?: number
}

/** Newest-first feedback for the admin list and the triage routine. */
export async function listFeedback(
  db: FeedbackDb,
  options: ListFeedbackOptions = {},
): Promise<Feedback[]> {
  const filters = [
    options.status ? eq(tables.feedback.status, options.status) : undefined,
    options.since ? gt(tables.feedback.createdAt, options.since) : undefined,
  ].filter((f) => f !== undefined)

  return db
    .select()
    .from(tables.feedback)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(tables.feedback.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
}

/** Move a row through triage, optionally linking the issue it became. */
export async function updateFeedbackStatus(
  db: FeedbackDb,
  id: string,
  patch: { status?: FeedbackStatus; issueUrl?: string | null },
): Promise<Feedback | null> {
  const [row] = await db
    .update(tables.feedback)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.issueUrl !== undefined ? { issueUrl: patch.issueUrl } : {}),
    })
    .where(eq(tables.feedback.id, id))
    .returning()
  return row ?? null
}

/** One row by id — the reply endpoint needs the whole thing, not a list slice. */
export async function findFeedbackById(db: FeedbackDb, id: string): Promise<Feedback | null> {
  const row = await db.query.feedback.findFirst({ where: eq(tables.feedback.id, id) })
  return row ?? null
}

/**
 * Where a reply to this submission should go.
 *
 * Signed-out submitters give a reply-to address explicitly; signed-in ones
 * never re-type theirs, so it comes off the user row. Returns null when there
 * is nowhere to write — anonymous feedback with no address is legitimate and
 * common, and the caller reports that as a 422 rather than an error.
 */
export async function feedbackReplyAddress(db: FeedbackDb, row: Feedback): Promise<string | null> {
  if (row.email) return row.email
  if (!row.userId) return null
  const user = await db.query.users.findFirst({
    where: eq(tables.users.id, row.userId),
    columns: { email: true },
  })
  return user?.email ?? null
}

/**
 * Stamp a row as replied. Separate from updateFeedbackStatus because the two
 * answer different questions — `status` is triage progress, `replied_at` is
 * whether a human ever wrote back — and conflating them means "closed" starts
 * silently meaning "we ignored it".
 *
 * Also advances `new` → `triaged`: replying to something IS triaging it. An
 * explicitly closed row stays closed.
 */
export async function markFeedbackReplied(
  db: FeedbackDb,
  id: string,
  adminId: string,
  now = new Date(),
): Promise<Feedback | null> {
  const existing = await findFeedbackById(db, id)
  if (!existing) return null

  const [row] = await db
    .update(tables.feedback)
    .set({
      repliedAt: now,
      repliedBy: adminId,
      ...(existing.status === 'new' ? { status: 'triaged' as const } : {}),
    })
    .where(eq(tables.feedback.id, id))
    .returning()
  return row ?? null
}
