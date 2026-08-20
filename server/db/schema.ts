import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

// Users — baseline table, extend with your own columns
export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull().default('user'),
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

// Type exports — use these in your app, not raw Drizzle types
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Entitlement = typeof entitlements.$inferSelect
export type NewEntitlement = typeof entitlements.$inferInsert
export type McpConnectCode = typeof mcpConnectCodes.$inferSelect
