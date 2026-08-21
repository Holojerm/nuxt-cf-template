import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Database Schema (Drizzle ORM + Cloudflare D1)
// ─────────────────────────────────────────────
// Convention:
//   - Table names: snake_case plural (e.g. users, posts)
//   - Column names: snake_case
//   - All tables have: id, created_at, updated_at
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
export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull().default('user'),
  provider: text('provider'),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  ...timestamps,
})

// Entitlements — one row per Paddle subscription, upserted by the webhook at
// server/routes/paddle/webhook.post.ts. Gate features with requireSubscription()
// (server/utils/billing.ts). `product_key` distinguishes plans/products when an
// app sells more than one thing ('default' otherwise).
export const entitlements = sqliteTable('entitlements', {
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
  ...timestamps,
})

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
    ...timestamps,
  },
  (table) => [
    index('feedback_status_created_idx').on(table.status, table.createdAt),
    index('feedback_ip_hash_created_idx').on(table.ipHash, table.createdAt),
  ],
)

// Type exports — use these in your app, not raw Drizzle types
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Entitlement = typeof entitlements.$inferSelect
export type NewEntitlement = typeof entitlements.$inferInsert
export type McpConnectCode = typeof mcpConnectCodes.$inferSelect
export type Feedback = typeof feedback.$inferSelect
export type NewFeedback = typeof feedback.$inferInsert
