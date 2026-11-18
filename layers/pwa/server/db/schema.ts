import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// The pwa layer's tables. NuxtHub merges every layer's server/db/schema.ts into
// `hub:db`; migrations stay app-owned, generated from that merged schema.

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

// Push subscriptions: one row per browser a person turned notifications on in.
//
// `endpoint` is unique because a browser has one subscription per site. When a
// second account turns notifications on in the same browser the row moves to
// it (server/utils/push-subscriptions.ts), so one person's notifications never
// reach the next person on a shared device.
//
// `user_id` is not a foreign key, for the reason above (a layer schema imports
// only drizzle). Account deletion removes the rows through the layer's account
// contributor.
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    // The push service's URL for this browser. Only ever a host on
    // PUSH_SERVICE_HOSTS (shared/utils/push.ts).
    endpoint: text('endpoint').notNull().unique(),
    // The browser's public key and auth secret (base64url), which every
    // message to it is encrypted with (RFC 8291).
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    // Last time the push service accepted a message. NULL = never sent to.
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [index('push_subscriptions_user_id_idx').on(table.userId)],
)

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert

// Idempotency keys: one row per write a client sent with an `Idempotency-Key`
// header (the outbox does, on every attempt), holding the answer the first
// attempt got. A replay after a lost response is given that answer back and
// writes nothing (server/utils/idempotency.ts, idempotency-keys.ts).
//
// Keyed per account: a key is the client's own UUID, and one person's key must
// never answer for another's. `status` is NULL while the first attempt is
// still running. Rows are swept after IDEMPOTENCY_KEY_DAYS by the purge task.
export const idempotencyKeys = sqliteTable(
  'pwa_idempotency_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    // The first attempt's HTTP status and JSON body.
    status: integer('status'),
    response: text('response'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('pwa_idempotency_keys_user_key_idx').on(table.userId, table.key),
    index('pwa_idempotency_keys_created_at_idx').on(table.createdAt),
  ],
)

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect
