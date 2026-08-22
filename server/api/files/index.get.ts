// GET /api/files — the caller's own uploads, newest first.
//
// Paid feature, same as the rest of this surface: a lapsed subscriber loses
// API access to the list (not the data — see server/api/files/[id].delete.ts
// for why deletion is never automatic on churn).
//
// Cursor-paginated over `files_user_id_created_idx`
// (server/db/schema.ts) — see server/utils/files.ts › listFiles() for why a
// cursor and not an offset.

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(64).optional(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)
  const query = await getValidatedQuery(event, querySchema.parse)

  const rows = await listFiles(db, user.id, { limit: query.limit, cursor: query.cursor })

  return {
    files: rows.map(toFileView),
    // The client's cue to ask for another page: pass this back as `cursor`.
    // Absent once a page comes back short of the limit — there's nothing
    // older left to ask for.
    nextCursor: rows.length === (query.limit ?? 20) ? (rows.at(-1)?.id ?? null) : null,
  }
})
