import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The files layer's table. NuxtHub merges every layer's server/db/schema.ts;
// the app's server/db/schema.ts re-exports this one so core's typed `db` and
// drizzle-kit see it. Migrations stay app-owned.
//
// `user_id` references core's `users`. The import below is relative to the
// app's schema, which sits at the same path in every app; `.references()`
// takes a lazy callback, so the cycle with that file's re-export is safe.
import { users } from '../../../../server/db/schema'

// A copy of core's timestamps helper, so this file needs no app helpers.
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

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

export type FileRecord = typeof files.$inferSelect
export type NewFileRecord = typeof files.$inferInsert
