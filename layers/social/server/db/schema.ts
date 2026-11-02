import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// The social layer's table. NuxtHub merges every layer's server/db/schema.ts
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

// Social posts — one row per (service, kind, ref). The unique index is the
// double-post guard: enqueueing the same thing twice is a no-op, so a caller
// can re-offer everything it might want posted on every tick.
//
// Rows are kept after sending: they are the record of what the app said in
// public, and a few per day never need a purge.
export const socialPosts = sqliteTable(
  'social_posts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // x | bluesky — see SOCIAL_SERVICES
    service: text('service').notNull(),
    // App-defined, e.g. 'alert' or 'digest'; with `ref` it names the post.
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    // JSON SocialBody: { posts: string[] }, more than one post is a thread.
    body: text('body').notNull(),
    // queued | sending | sent | dry-run | suppressed | failed | unknown — see SOCIAL_STATUSES
    status: text('status').notNull().default('queued'),
    // Not sent before this. A hold window is just a later not_before.
    notBefore: integer('not_before', { mode: 'timestamp' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    // Buffer's post id, once Buffer accepted it.
    remoteId: text('remote_id'),
    error: text('error'),
    sentAt: integer('sent_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('social_posts_service_kind_ref_idx').on(table.service, table.kind, table.ref),
    index('social_posts_status_not_before_idx').on(table.status, table.notBefore),
  ],
)

export type SocialPost = typeof socialPosts.$inferSelect
export type NewSocialPost = typeof socialPosts.$inferInsert
