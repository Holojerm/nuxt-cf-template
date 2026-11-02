import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The feedback layer's table. NuxtHub merges every layer's server/db/schema.ts
// into `hub:db` and `@nuxthub/db/schema`; migrations stay app-owned, generated
// from that merged schema (drizzle.config.ts).

// A copy of core's timestamps helper: a layer schema imports only drizzle, so
// drizzle-kit and NuxtHub can load it without app aliases.
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

// Feedback — first-party customer feedback capture (POST /api/feedback).
// PostHog tells you what users *did*; this table is what they *said*, and it's
// yours: joinable against users/entitlements, and it survives dropping PostHog.
//
// `user_id` is deliberately NOT a foreign key. Feedback is accepted from signed-
// out visitors (null) and must never be lost to a constraint failure when a
// session exists for a user row that doesn't (OAuth-first sign-in, seeded envs).
// `ip_hash` is a salted SHA-256 — enough to rate-limit, useless as an identifier.
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id'),
    // bug | idea | praise | confusion | other — see FEEDBACK_KINDS
    kind: text('kind').notNull().default('idea'),
    message: text('message').notNull(),
    // Optional 1–5 satisfaction score for programmatic prompts (post-cancellation,
    // post-onboarding). The in-app widget leaves it null.
    rating: integer('rating'),
    // Reply-to address, only collected from signed-out submitters.
    email: text('email'),
    // Route the user was on when they submitted.
    path: text('path'),
    // Deep link to the PostHog session replay of this moment — the single most
    // useful field on a bug report.
    replayUrl: text('replay_url'),
    posthogDistinctId: text('posthog_distinct_id'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    // new | triaged | closed — see FEEDBACK_STATUSES
    status: text('status').notNull().default('new'),
    // Set once the feedback-triage routine (or a human) files it.
    issueUrl: text('issue_url'),
    // Set when a human replies from /admin/feedback. Feedback with no return
    // path is extraction, not a loop — and the triage routine is forbidden from
    // replying on its own (.claude/routines/feedback-triage.md), so this column
    // only ever moves because a person decided it should.
    repliedAt: integer('replied_at', { mode: 'timestamp' }),
    /** The admin user id that sent the reply — support context, not authz. */
    repliedBy: text('replied_by'),
    ...timestamps,
  },
  (table) => [
    index('feedback_status_created_idx').on(table.status, table.createdAt),
    index('feedback_ip_hash_created_idx').on(table.ipHash, table.createdAt),
  ],
)

export type Feedback = typeof feedback.$inferSelect
export type NewFeedback = typeof feedback.$inferInsert
