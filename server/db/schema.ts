import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Conventions: snake_case plural tables and snake_case columns; every table has
// id, created_at and updated_at, except append-only tables, which omit
// updated_at rather than lie about it (audit_log); foreign keys are
// <table_singular>_id.

// Timestamps helper — spread into every table
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

// Users — baseline table, extend with your own columns.
//
// `email` is the account key: sign-in links providers by verified email rather
// than minting a row per provider (see server/utils/users.ts). `provider` is
// support context only, never an authorization input.
export const users = sqliteTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    role: text('role').notNull().default('user'),
    provider: text('provider'),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
    // Revocation primitive for sealed-cookie sessions, which store nothing
    // server-side. Every session carries its issue second
    // (server/utils/auth.ts › establishSession); one issued before this instant
    // is dead, checked per request by server/middleware/auth.ts. A timestamp, not
    // a `deleted_at` flag, so it also answers "sign out everywhere" and admin
    // force-logout. NULL = never revoked. A session with no issued-at that meets
    // a non-null value is treated as revoked: "cannot prove" has to mean no.
    sessionsInvalidBefore: integer('sessions_invalid_before', { mode: 'timestamp' }),
    // First-touch attribution, written once at account creation from the cookie
    // set on the first landing (shared/utils/attribution.ts), never updated:
    // last-touch overwrites destroy "which channel produced this customer".
    // Duplicated from PostHog because ad blockers make that record lossy exactly
    // where it matters; these are first-party and joinable to `entitlements`.
    signupSource: text('signup_source'),
    signupMedium: text('signup_medium'),
    signupCampaign: text('signup_campaign'),
    signupReferrer: text('signup_referrer'),
    // Route shape of the first page seen (shared/utils/landing-path.ts): no
    // query string, ids and tokens collapsed to `:id`. NULL before 0026.
    signupLanding: text('signup_landing'),
    // The user's own code, minted at provisioning (server/utils/users.ts).
    // Nullable: legacy accounts have none and backfilling would hand codes to
    // dormant accounts. Nullable-unique is right: SQLite treats NULLs as distinct
    // in a unique index.
    referralCode: text('referral_code').unique(),
    // The *other* account's referral_code, resolved at signup. Deliberately NOT a
    // foreign key (as with `feedback.user_id`): a blocked signup is a lost
    // customer, and attribution must survive the referrer's row being deleted.
    referredBy: text('referred_by'),
    ...timestamps,
  },
  (table) => [
    // "How many people used my code", read on every /account referral-card view;
    // unindexed that is a full users scan. Not unique: many accounts share a code.
    index('users_referred_by_idx').on(table.referredBy),
  ],
)

// MCP connect codes — short-lived, single-use codes bridging the app's session
// auth to the MCP worker's OAuth flow. Minted for the signed-in user by
// POST /api/mcp/connect-code, bound to the sign-in the worker started, and
// redeemed (by hash) at the worker's /authorize/callback. The browser carries
// the code across; nobody types it. Only the SHA-256 hash is stored.
export const mcpConnectCodes = sqliteTable(
  'mcp_connect_codes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [
    // Redemption uses the unique `code_hash` index; these two serve only the
    // nightly sweep in server/utils/purge.ts, whose OR needs an index per branch.
    index('mcp_connect_codes_expires_at_idx').on(table.expiresAt),
    index('mcp_connect_codes_used_at_idx').on(table.usedAt),
  ],
)

// Magic-link tokens — the primary consumer sign-in path (POST /api/auth/magic-link,
// redeemed from /auth/verify). Built like mcp_connect_codes: SHA-256 hash only,
// single-use, minutes to live.
//
// Deliberately NOT joined to `users`: a link is minted for an *address*, which
// lets one endpoint serve sign-in and sign-up with an identical response (a
// differing one is an account-enumeration oracle). The account is
// found-or-created at redemption.
export const magicLinkTokens = sqliteTable(
  'magic_link_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Normalized with normalizeEmail(), so it keys identically to `users.email`.
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    // These ride on the row, not cookies: a magic link routinely finishes in a
    // different browser than it started in (laptop request, phone open), where
    // the `auth-redirect` and `attr` cookies do not exist. `redirect_to` is
    // passed through safeRedirectPath() before it is written; it comes from a
    // query string, so unfiltered it would be an open-redirect store.
    redirectTo: text('redirect_to'),
    // First-touch attribution, same five columns as `users`.
    signupSource: text('signup_source'),
    signupMedium: text('signup_medium'),
    signupCampaign: text('signup_campaign'),
    signupReferrer: text('signup_referrer'),
    signupLanding: text('signup_landing'),
    // The fifth field of the same cookie, and the one worth money: a lost
    // `signup_source` reads `direct`, a lost referral code silently denies
    // someone promised days, and cross-device (no `attr` cookie on the phone) is
    // the common magic-link path. NOT a foreign key, like `users.referred_by`: it
    // is an unverified cookie claim resolved at redemption
    // (layers/referral/server/utils/referral-codes.ts › findReferrerByCode), and
    // a constraint would let a junk value fail someone's sign-in.
    referralCode: text('referral_code'),
    // The canonical mailbox (server/utils/users.ts › canonicalizeEmailForLimiting)
    // the per-address budget counts on: `victim+1@gmail.com` … `+9999` are one
    // inbox. Empty on rows written before the column existed.
    mailbox: text('mailbox').notNull().default(''),
    ...timestamps,
  },
  (table) => [
    // Lookup is by `token_hash` (unique); this serves the sweep by address in
    // server/utils/magic-link.ts › createMagicLinkToken and support queries.
    index('magic_link_tokens_email_created_idx').on(table.email, table.createdAt),
    // The per-address budget, counted in the same D1 transaction as the insert.
    index('magic_link_tokens_mailbox_created_idx').on(table.mailbox, table.createdAt),
    // server/utils/purge.ts selects `expires_at < cutoff OR (used_at IS NOT NULL
    // AND used_at < cutoff)`. BOTH columns are indexed: SQLite serves an OR from
    // an index union only if every branch has an index, else it scans anyway.
    index('magic_link_tokens_expires_at_idx').on(table.expiresAt),
    index('magic_link_tokens_used_at_idx').on(table.usedAt),
  ],
)

/**
 * Structured context on an audit row: flat and scalar-only, because it is read
 * by a human at 2am and survives `LIKE '%…%'`. Widen the union if you must,
 * never to `any` (un-serializable objects in a TEXT column).
 */
export type AuditMetadata = Record<string, string | number | boolean | null>

// Audit log — append-only record of privileged actions (admin acting on another
// user's data, a system job changing an entitlement, anything you would need to
// explain to a customer or a regulator).
//
// It does NOT spread `timestamps`: an `updated_at` on never-updated rows invites
// code to "correct" a row, and a correctable audit trail is not one. Retention
// is a delete-by-age job, not an edit.
//
// `actor_user_id` is deliberately NOT a foreign key:
//   1. Rows must outlive the actor; erasure must neither cascade them away nor
//      be blocked by them.
//   2. System actors have no user row (`actor_type = 'system'`, sentinel id).
//   3. The write must never fail: an unrecorded action is worse than an orphaned
//      row, and a constraint failure would 500 the privileged operation itself.
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text('actor_user_id').notNull(),
    // admin | system | user. notNull: a null makes a row ambiguous forever. 'user'
    // is a person acting on their own account (actorUserId == targetId).
    actorType: text('actor_type').notNull().default('admin'),
    // Verb, past tense and namespaced: 'user.role_changed', 'feedback.replied'.
    action: text('action').notNull(),
    // Null when the action has no single subject (bulk export, config change).
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: text('metadata', { mode: 'json' }).$type<AuditMetadata>(),
    // Salted SHA-256, same construction as `feedback.ip_hash`: tells sessions
    // apart in an investigation, useless as an identifier.
    ipHash: text('ip_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The one real query: "everything <actor> did, newest first."
    index('audit_log_actor_user_id_created_idx').on(table.actorUserId, table.createdAt),
  ],
)

// Notification preferences — per-user, per-channel, per-event opt-outs.
//
// Absence of a row means default-on: only exceptions are stored, so a new event
// type needs no backfill and a failed read degrades toward sending.
//
// Billing and security mail is NOT opt-out-able, and that rule must never be a
// column: once the exemption is data, a bad UPDATE or a helpful admin can
// silence "your card was declined". It lives in the reader, a hardcoded
// allowlist checked before the lookup.
export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // email today; push/sms later. notNull for the unique index below.
    channel: text('channel').notNull().default('email'),
    // The event opted out of, matching the keys of
    // layers/billing/server/utils/billing-notifications.ts › decideNotification.
    eventType: text('event_type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    // One row per (user, channel, event), or a lookup meets contradictory answers.
    // `channel` and `event_type` are notNull because SQLite treats NULLs as
    // distinct in a unique index, which would let duplicates through.
    uniqueIndex('notification_preferences_user_channel_event_idx').on(
      table.userId,
      table.channel,
      table.eventType,
    ),
  ],
)

// Lifecycle email sends — one row per (user, step, subject), written BEFORE the
// send (server/utils/lifecycle.ts). The unique index is the idempotency guard:
// racing or retried cron runs cannot mail the same step twice, because only one
// INSERT wins. `subject_key` makes a step repeatable where it should be: '' for
// once-per-account, the pass's end date for the expiring-pass reminder. Kept
// after account deletion (names a user id, never an address).
export const lifecycleSends = sqliteTable(
  'lifecycle_sends',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    stepId: text('step_id').notNull(),
    subjectKey: text('subject_key').notNull().default(''),
    sentAt: integer('sent_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('lifecycle_sends_user_step_subject_idx').on(
      table.userId,
      table.stepId,
      table.subjectKey,
    ),
    index('lifecycle_sends_step_idx').on(table.stepId),
  ],
)

// Email subscribers — visitors with no account who asked for product news
// (server/utils/subscribers.ts). Double opt-in: a row with no `confirmed_at` has
// been sent one confirmation email and nothing else, and the daily purge removes
// it after a week. Unsubscribing deletes the row, so there is no "unsubscribed"
// state to keep. An address that has an account is never mailed from here: the
// account's own preference decides.
export const emailSubscribers = sqliteTable(
  'email_subscribers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull().unique(),
    confirmedAt: integer('confirmed_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [index('email_subscribers_confirmed_idx').on(table.confirmedAt)],
)

// What a subscriber was sent: the `lifecycle_sends` of people with no account,
// claimed before the send through the same kind of unique index. No foreign key,
// so the row outlives the subscriber (it names an id, never an address) and the
// counts in GET /api/fleet do not move when someone unsubscribes.
export const subscriberSends = sqliteTable(
  'subscriber_sends',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriberId: text('subscriber_id').notNull(),
    stepId: text('step_id').notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('subscriber_sends_subscriber_step_idx').on(table.subscriberId, table.stepId),
    index('subscriber_sends_step_idx').on(table.stepId),
  ],
)

// Announcement runs — one row per announcement, created when its send starts
// (server/utils/announcements.ts). The cursor is what makes the send a single
// pass: each recipient is visited once, so one skipped by the weekly cap is
// counted in `capped` and never queued for a later day. `stage` is `users`, then
// `subscribers`; `finished_at` set means the pass is over.
export const announcementRuns = sqliteTable('announcement_runs', {
  announcementId: text('announcement_id').primaryKey(),
  stage: text('stage').notNull().default('users'),
  cursor: text('cursor').notNull().default(''),
  sent: integer('sent').notNull().default(0),
  capped: integer('capped').notNull().default(0),
  optedOut: integer('opted_out').notNull().default(0),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  ...timestamps,
})

// Instance secrets — server-generated derivation salts, one row each.
//
// Not another env var: a new secret is a human gate every fork would have to
// clear (server/utils/unsubscribe.ts derives its key from `sessionPassword` for
// that reason). The referral welcome trial cannot: its salt must be STABLE
// FOREVER. The once-per-mailbox invariant is a deterministic ref
// (`welcome_<hash of mailbox>`) meeting a unique index, so a changed salt
// re-arms every spent trial, and `sessionPassword` is meant to be rotatable
// after a compromise. So the salt is generated once at random and never rotated.
//
// Server-generated derivation material ONLY: never user input, never anything a
// request can name, so this can never become a generic key/value store. No
// personal data; not exported.
export const instanceSecrets = sqliteTable('instance_secrets', {
  // A constant chosen in code (IDENTITY_SALT_ID), never user-supplied.
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
})

// Ops events — the alerting spool. Workers Logs cannot be alerted on, so the
// Worker writes what it noticed here; the fleet dashboard reads it through
// GET /api/fleet (`ops.kinds`) and does the mailing. Distinct from `feedback`
// (what a person said): different retention (pruned after OPS_EVENT_RETENTION_DAYS
// by the daily purge), audience and triage.
export const opsEvents = sqliteTable('ops_events', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  kind: text('kind').notNull(), // a `kind` from the log taxonomy, e.g. server_error
  detail: text('detail'), // one-line human summary — the fleet alert quotes it
  path: text('path'), // request path, when there was one (query already stripped)
  ...timestamps,
})

// Rate-limit counters: one row per caller, endpoint and window, moved by one
// atomic statement (server/utils/rate-limit.ts). `bucket` is a hash, so no
// address or mailbox is kept. A row outlives its window only until the daily
// purge.
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    bucket: text('bucket').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('rate_limits_expires_idx').on(table.expiresAt)],
)

// Type exports
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type LifecycleSend = typeof lifecycleSends.$inferSelect
export type EmailSubscriber = typeof emailSubscribers.$inferSelect
export type AnnouncementRun = typeof announcementRuns.$inferSelect
export type McpConnectCode = typeof mcpConnectCodes.$inferSelect
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert
export type AuditLogEntry = typeof auditLog.$inferSelect
export type NewAuditLogEntry = typeof auditLog.$inferInsert
export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type OpsEvent = typeof opsEvents.$inferSelect
export type NewOpsEvent = typeof opsEvents.$inferInsert
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert

// Composition root: re-exports each layer's schema so the typed `db` and
// drizzle-kit see its tables (NuxtHub merges them on its own). Removing a layer
// means deleting its line and running `bun run db:generate`.
export * from '../../layers/billing/server/db/schema'
export * from '../../layers/credentials/server/db/schema'
export * from '../../layers/feedback/server/db/schema'
export * from '../../layers/files/server/db/schema'
export * from '../../layers/pwa/server/db/schema'
export * from '../../layers/social/server/db/schema'
