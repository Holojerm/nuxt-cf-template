import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Database Schema (Drizzle ORM + Cloudflare D1)
// ─────────────────────────────────────────────
// Convention:
//   - Table names: snake_case plural (e.g. users, posts)
//   - Column names: snake_case
//   - All tables have: id, created_at, and updated_at — unless the table is
//     append-only, in which case updated_at is omitted rather than lied about
//     (see audit_log)
//   - Foreign keys: <table_singular>_id (e.g. user_id)
// ─────────────────────────────────────────────

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
// than minting a row per provider (see server/utils/users.ts for why).
// `provider` records which one created the account — support context only,
// never an authorization input.
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
    // ── Session revocation ─────────────────────────────────────────────────────
    // Sessions are self-contained sealed cookies: nothing is stored server-side,
    // so nothing could previously be taken away. Delete your account from your
    // laptop and your phone kept full access to the retained entitlements until
    // the cookie expired, because every check in the app reads the cookie and
    // stops there.
    //
    // This column is the revocation primitive that was missing. Every session
    // carries the second it was issued (server/utils/auth.ts › establishSession);
    // a session issued before this instant is dead, checked on every
    // authenticated request by server/middleware/auth.ts. Deletion sets it, and
    // it is deliberately a *timestamp* rather than a `deleted_at` flag so the same
    // column also answers "sign me out everywhere" and "an admin force-logged this
    // account out" without another migration.
    //
    // NULL means nothing has ever been revoked — the state every account is in.
    // A session with no issued-at that meets a non-null value here is treated as
    // revoked: it cannot prove it postdates the revocation, and on this column
    // "cannot prove" has to mean no.
    sessionsInvalidBefore: integer('sessions_invalid_before', { mode: 'timestamp' }),
    // ── First-touch attribution ────────────────────────────────────────────────
    // Written once, at account creation, from the cookie the attribution plugin
    // set on the visitor's first landing (shared/utils/attribution.ts). Never
    // updated afterwards — the question these answer is "which channel produced
    // this customer", and last-touch overwrites destroy that the moment someone
    // returns via a branded search.
    //
    // PostHog already keeps $initial_utm_* on the person, so why duplicate?
    // Because that record is lossy exactly where it matters: ad blockers drop the
    // SDK, and the visitors most likely to block are not a random sample. These
    // columns are first-party, joinable against `entitlements` in one SQL query,
    // and survive dropping PostHog — the same reasoning as the `feedback` table.
    signupSource: text('signup_source'),
    signupMedium: text('signup_medium'),
    signupCampaign: text('signup_campaign'),
    signupReferrer: text('signup_referrer'),
    // ── Referrals ──────────────────────────────────────────────────────────────
    // The user's own code, minted once at provisioning (server/utils/users.ts).
    // Nullable because accounts created before this column existed have none, and
    // backfilling would hand codes to dormant accounts that will never share one.
    // Unique, and nullable-unique is exactly right here: SQLite treats NULLs as
    // distinct in a unique index, so every legacy row coexists while every minted
    // code is still guaranteed to point at one account.
    referralCode: text('referral_code').unique(),
    // Who referred this user — the *other* account's referral_code, resolved at
    // signup. Deliberately NOT a foreign key, for the reasons written out on
    // `feedback.user_id` below: attribution must never be lost to a constraint
    // failure, and the answer to "where did this customer come from" has to
    // survive the referrer's row being deleted. A dangling code is a readable
    // fact; a blocked signup is a lost customer.
    referredBy: text('referred_by'),
    ...timestamps,
  },
  (table) => [
    // "How many people used my code" — rendered on /account for every signed-in
    // visitor who opens the referral card. Unindexed it was a full scan of the
    // users table on a page view, which is the one shape of slow query that
    // gets worse exactly as the product succeeds.
    //
    // Not unique: many accounts share one referrer's code, which is the point.
    index('users_referred_by_idx').on(table.referredBy),
  ],
)

// Entitlements — one row per Paddle subscription, upserted by the webhook at
// server/routes/paddle/webhook.post.ts. Gate features with requireSubscription()
// (server/utils/billing.ts). `product_key` distinguishes plans/products when an
// app sells more than one thing ('default' otherwise).
export const entitlements = sqliteTable(
  'entitlements',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    paddleCustomerId: text('paddle_customer_id'),
    paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
    productKey: text('product_key').notNull().default('default'),
    // Paddle subscription statuses: active | trialing | past_due | paused | canceled
    status: text('status').notNull(),
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp' }),
    // ── Paddle's scheduled_change ──────────────────────────────────────────────
    // "Cancel at period end" does NOT change a subscription's status. Paddle
    // keeps it `active` and attaches `scheduled_change: { action, effective_at }`
    // until the date arrives, so a row that will never be billed again is
    // indistinguishable from one that renews next month — unless these are
    // stored. Without them the deletion guard refused, for months, to delete an
    // account whose subscription was already cancelled, and told the customer to
    // go cancel it.
    //
    // `action` is Paddle's own vocabulary (`cancel` | `pause` | `resume`), kept
    // verbatim rather than mapped to a local enum: the set is theirs to extend,
    // and a value we do not recognise should read as "something is scheduled"
    // rather than be silently dropped.
    //
    // BOTH are cleared when Paddle sends `scheduled_change: null` — that is how a
    // customer un-cancels, and a stale value here would keep an active
    // subscription looking dead forever.
    scheduledChangeAction: text('scheduled_change_action'),
    scheduledChangeAt: integer('scheduled_change_at', { mode: 'timestamp' }),
    // ── Derived entitlements ───────────────────────────────────────────────────
    // Set on a row that exists BECAUSE of another row's purchase — today only a
    // referral reward, whose ref is `referral_<refereeId>` and which Paddle has
    // therefore never heard of. This names the Paddle ref that earned it.
    //
    // Without it the clawback had to be keyed on the referee's *identity*, which
    // is the wrong key in three directions at once: a refund of that person's
    // SECOND purchase revoked the reward earned on their first, a partial refund
    // revoked a reward the money had not actually reversed, and a reward could
    // never be re-earned because nothing distinguished "which purchase was this
    // for". Keyed on the purchase, each of those answers itself.
    //
    // NULL on every ordinary row, and on referral rows granted before this column
    // existed — which is why the cascade treats NULL as "provenance unknown, do
    // not touch". A missed clawback is recoverable; clawing back a reward that
    // was legitimately earned is a support conversation with an honest customer.
    earnedFromRef: text('earned_from_ref'),
    // The window that was in force before a derived row was revoked, so the
    // revocation can be undone. A revoke sets `current_period_end = now` (both
    // halves must agree — see revokeForAdjustment), which destroys the original
    // date; a chargeback the merchant later WINS has to put it back, and
    // "recompute it" is not available once the row has been overwritten.
    //
    // NULL means "not revoked by the cascade", which is what makes it the exact
    // predicate the restore matches on — a row nobody took away cannot be
    // "restored" into a window it never had.
    restorePeriodEnd: integer('restore_period_end', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [
    // Every read of this table that isn't keyed on the unique Paddle ref is
    // keyed on the owner: getBillingOverview (the /account page and the admin
    // console), the deletion guard, and countReferralRewards. Without this the
    // table was full-scanned on every one of them, and it only grows.
    //
    // Deliberately NOT composite with `product_key`. Per-account row counts are
    // tiny — a handful of purchases over a lifetime — so once the index has
    // narrowed to one user, filtering the rest in memory costs nothing, and a
    // single-column index serves the queries that don't mention product_key
    // (the deletion guard scans every product on purpose) as well as the ones
    // that do.
    //
    // It also covers the LIKE in countReferralRewards, which could not use the
    // unique index on `paddle_subscription_id` for a prefix match anyway: under
    // SQLite's rules a LIKE only becomes an index range scan for a column with
    // NOCASE collation and no ESCAPE clause, and ours has an ESCAPE clause
    // precisely because `_` is a wildcard (see server/utils/sql.ts).
    index('entitlements_user_id_idx').on(table.userId),
  ],
)

// MCP connect codes — short-lived, single-use codes bridging the app's session
// auth to the MCP worker's OAuth flow (device-code style). Minted for the
// signed-in user by POST /api/mcp/connect-code; redeemed (by hash) on the MCP
// worker's /authorize page. Only the SHA-256 hash is stored.
export const mcpConnectCodes = sqliteTable('mcp_connect_codes', {
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
})

// Magic-link tokens — the primary consumer sign-in path. Minted by
// POST /api/auth/magic-link, redeemed from /auth/verify. Same construction as
// mcp_connect_codes above and for the same reasons: only the SHA-256 hash is
// stored, the row is single-use, and it expires in minutes.
//
// Deliberately NOT joined to `users`, and that is the point rather than an
// omission. A link is minted for an *address*, not an account, which is what
// lets one endpoint serve sign-in and sign-up with an identical response — an
// endpoint that behaved differently for a known address would be an account
// enumeration oracle. The account is found-or-created at redemption.
export const magicLinkTokens = sqliteTable(
  'magic_link_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Normalized with normalizeEmail() before it is written, so this row and the
    // `users.email` it eventually resolves to are keyed identically.
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    // ── Why these ride on the row instead of being read from cookies ──────────
    // A magic link is the one sign-in flow that routinely *finishes in a
    // different browser than it started in*: request it on the laptop, open the
    // mail on the phone. Both values below normally come from cookies on the
    // requesting browser (`auth-redirect`, `attr`), and on that path neither
    // cookie exists when the session is established. Capturing them at mint time
    // is what stops a deep link and a first-touch channel from being silently
    // lost on every cross-device signup — and cross-device is not an edge case
    // for email sign-in, it's the default on mobile.
    //
    // `redirect_to` is passed through safeRedirectPath() before it is written.
    // It originates in a query string, so storing it unfiltered would turn this
    // table into an open-redirect store with a 15-minute fuse.
    redirectTo: text('redirect_to'),
    // First-touch attribution, same four columns as `users` — written there by
    // establishSession() if this link ends up creating the account.
    signupSource: text('signup_source'),
    signupMedium: text('signup_medium'),
    signupCampaign: text('signup_campaign'),
    signupReferrer: text('signup_referrer'),
    // The fifth field of the same cookie, and the only one that is worth money.
    //
    // It rides here for exactly the reason the four above do, but the cost of
    // omitting it is different in kind. A lost `signup_source` is a marketing
    // row that reads `direct`; a lost referral code is a person who was
    // promised days for inviting a friend and silently did not get them — and
    // the case where it goes missing is *cross-device*, which for email sign-in
    // is the common path rather than the edge one. Requested on a laptop,
    // opened on a phone: no `attr` cookie exists on the phone, so without this
    // column the credit simply evaporates on the majority of magic-link signups.
    //
    // Deliberately NOT a foreign key to `users.referral_code`, matching
    // `users.referred_by`: this is an unverified claim copied off a cookie, and
    // it is resolved to a real, live, other account at redemption
    // (server/utils/users.ts › findReferrerByCode). A constraint here would let
    // a junk cookie value fail somebody's sign-in.
    referralCode: text('referral_code'),
    ...timestamps,
  },
  (table) => [
    // Rows are looked up by `token_hash` (unique index, free) and swept by
    // address when that address requests its next link — see
    // server/utils/magic-link.ts › createMagicLinkToken. This index serves the
    // sweep, and the support question "how many links did this address ask for".
    index('magic_link_tokens_email_created_idx').on(table.email, table.createdAt),
  ],
)

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

/**
 * Structured context on an audit row. Deliberately flat and scalar-only rather
 * than `unknown` or a nested blob: an audit row is read by a human at 2am
 * trying to reconstruct what happened, and a nested JSON tree does not get
 * read. Flat key/value also survives `LIKE '%…%'` when you have no index and no
 * time. Widen this union if you must — never to `any`, which would put
 * arbitrary un-serializable objects into a column D1 stores as TEXT.
 */
export type AuditMetadata = Record<string, string | number | boolean | null>

// Audit log — append-only record of privileged actions (admin acting on another
// user's data, a system job changing an entitlement, anything you would need to
// explain to a customer or a regulator).
//
// Append-only is the whole point, so it does NOT spread `timestamps`. An
// `updated_at` on a table whose rows are never updated is a standing lie: it
// invites code to "correct" a row, and a correctable audit trail is not one.
// Rows are only ever inserted and read. Retention is a delete-by-age job, not
// an edit.
//
// `actor_user_id` is deliberately NOT a foreign key — three reasons, all of
// which point the same way:
//   1. Audit rows must outlive the actor. Deleting an account (or honouring an
//      erasure request) must not cascade away the record of what that account
//      did, nor be blocked by it.
//   2. Not every actor is a user row. System actions record a sentinel id with
//      `actor_type = 'system'`; an FK would make the most important class of
//      automated action unrecordable.
//   3. The write must never fail. Same reasoning as `feedback.user_id` below:
//      an action that happened but went unrecorded is strictly worse than an
//      orphaned row, and a constraint failure here would 500 the privileged
//      operation itself.
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text('actor_user_id').notNull(),
    // admin | system | user — notNull with a default because a null here makes
    // a row ambiguous forever, and an ambiguous audit row is not evidence.
    // 'user' is a person acting on their own account (e.g. self-serve
    // deletion) — actorUserId and targetId are the same id on those rows.
    actorType: text('actor_type').notNull().default('admin'),
    // Verb, past tense and namespaced: 'user.role_changed', 'feedback.replied'.
    action: text('action').notNull(),
    // What was acted on. Null when the action has no single subject (a bulk
    // export, a config change), which is why neither column is notNull.
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: text('metadata', { mode: 'json' }).$type<AuditMetadata>(),
    // Salted SHA-256, same construction as `feedback.ip_hash` — enough to tell
    // two sessions apart in an investigation, useless as an identifier.
    ipHash: text('ip_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The only query this table serves in anger: "everything <actor> did,
    // newest first."
    index('audit_log_actor_user_id_created_idx').on(table.actorUserId, table.createdAt),
  ],
)

// Files — metadata for objects in R2, written by the upload path.
//
// The invariant this table exists to record: `r2_key` is **user-scoped**, of the
// form `uploads/<user_id>/<something>`. The API enforces it by constructing the
// key from the session rather than accepting one from the client; the schema
// documents it so nobody later adds an endpoint that takes a caller-supplied
// key and turns a list-my-files query into a read-anyone's-files bug. The
// unique index on `r2_key` is the backstop: two rows can never claim one object.
//
// `user_id` IS a real foreign key here, unlike `audit_log.actor_user_id` — the
// opposite decision for the opposite reason. A file row whose owner is gone is
// not evidence of anything; it is an unreachable row pointing at an R2 object
// nobody can list, download, or bill for. Failing loudly at write time beats
// accumulating orphans that quietly cost money.
export const files = sqliteTable(
  'files',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // As supplied by the user — display only. Never used to build `r2_key`, or a
    // filename of `../../etc/passwd` becomes a path traversal.
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    r2Key: text('r2_key').notNull().unique(),
    // pending | uploaded. The row is written before the object exists in R2 —
    // the server writes it there itself (server/api/files/index.post.ts), not
    // the client directly — so `pending` is the honest default and a row that
    // never reaches `uploaded` is an abandoned upload for a sweeper to collect.
    status: text('status').notNull().default('pending'),
    // pending → uploaded is a real transition, so updated_at means something here
    // — unlike on audit_log above.
    ...timestamps,
  },
  (table) => [
    // "This user's files, newest first" — the one query the upload feature is
    // built around. Composite rather than a bare `user_id` index because the
    // ORDER BY is half the query: with only `user_id`, SQLite finds the rows by
    // index and then sorts them in a temp B-tree, so the user with the most
    // files pays the most to list them — the exact wrong shape for a table that
    // only ever grows. Leading with `user_id` also keeps this usable for a plain
    // "how many files does this user have" count.
    index('files_user_id_created_idx').on(table.userId, table.createdAt),
  ],
)

// Notification preferences — per-user, per-channel, per-event opt-outs.
//
// Absence of a row means **default-on**. Storing only the exceptions is what
// keeps this table from needing a backfill every time a new event type ships,
// and it means a failed read degrades toward sending rather than toward silence.
//
// Billing and security mail (payment failed, subscription cancelled, sign-in
// from a new device) is NOT opt-out-able, and that rule does NOT live here.
// There is no column for it and there must never be one: the moment the
// exemption is data, a bad UPDATE or a helpful admin can switch off the email
// that tells someone their card was declined. It belongs in the reader function
// that consults this table — a hardcoded allowlist of always-send event types
// checked before the lookup, so no row in this table can suppress them.
export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // email today; push/sms later. notNull — see the unique index below.
    channel: text('channel').notNull().default('email'),
    // The event being opted out of, matching the keys the notification decider
    // uses (server/utils/billing-notifications.ts › decideNotification).
    eventType: text('event_type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    // One row per (user, channel, event) — anything else and a "did they opt
    // out?" lookup has to pick between contradictory answers.
    //
    // This is also why `channel` and `event_type` are notNull: SQLite treats
    // NULLs as distinct in a unique index, so a nullable component would let
    // unlimited duplicate rows through the constraint that exists to stop them.
    uniqueIndex('notification_preferences_user_channel_event_idx').on(
      table.userId,
      table.channel,
      table.eventType,
    ),
  ],
)

// Instance secrets — server-generated derivation salts, one row each.
//
// ── Why this exists rather than another env var ──────────────────────────────
// server/utils/unsubscribe.ts states the rule this table follows: "a new secret
// is a human gate — every fork of this template would have to go set one before
// this feature worked at all." That is why the unsubscribe key is derived from
// `sessionPassword` instead of being its own secret.
//
// The referral welcome trial cannot use that trick, and the reason is narrow
// but decisive: its salt has to be STABLE FOREVER. The once-per-mailbox
// invariant is enforced by a deterministic ref (`welcome_<hash of mailbox>`)
// meeting a unique index, so if the salt ever changes, every mailbox gets a
// brand-new ref and every spent trial silently re-arms. `sessionPassword` is a
// secret an operator is supposed to be able to rotate after a compromise, and
// "rotating your session secret quietly hands out a free month to everyone who
// already used one" is not a property anybody would predict.
//
// So the salt is generated here, once, at random, and never rotated. It costs a
// fork nothing to set up — which is the same goal the no-new-secret rule was
// serving, reached by the other road.
//
// ── What may and may not live here ───────────────────────────────────────────
// Server-generated derivation material ONLY. Never user input, never anything
// rendered, never anything a request can name — an id here is chosen by code in
// this repo, so this table can never become a generic key/value store that a
// handler writes into. It holds no personal data and is not exported.
export const instanceSecrets = sqliteTable('instance_secrets', {
  // A constant chosen in code, e.g. IDENTITY_SALT_ID. Not user-supplied.
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
})

// Type exports — use these in your app, not raw Drizzle types
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Entitlement = typeof entitlements.$inferSelect
export type NewEntitlement = typeof entitlements.$inferInsert
export type McpConnectCode = typeof mcpConnectCodes.$inferSelect
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert
export type Feedback = typeof feedback.$inferSelect
export type NewFeedback = typeof feedback.$inferInsert
export type AuditLogEntry = typeof auditLog.$inferSelect
export type NewAuditLogEntry = typeof auditLog.$inferInsert
// `FileRecord`, not `File` — `File` is a DOM/Workers global, and shadowing it
// here would silently retype every `File` in upload code that forgot to import.
export type FileRecord = typeof files.$inferSelect
export type NewFileRecord = typeof files.$inferInsert
export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert
