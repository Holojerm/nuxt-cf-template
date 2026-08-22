// GET /api/files — the caller's own uploads, newest first.
//
// Paid feature, same as the rest of this surface: a lapsed subscriber loses
// API access to the list (not the data — see server/api/files/[id].delete.ts
// for why deletion is never automatic on churn).
//
// Cursor-paginated over `files_user_id_created_idx`
// (server/db/schema.ts) — see server/utils/files.ts › listFiles() for why a
// cursor and not an offset, and why it encodes `(createdAt, id)` rather
// than a bare row id.

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // The opaque token from a previous response's `nextCursor` — decoded and
  // validated below, not here: a Zod length check alone can't tell a
  // well-formed cursor from a tampered one, only decodeFilesCursor() can.
  cursor: z.string().max(300).optional(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)
  const query = await getValidatedQuery(event, querySchema.parse)

  let cursor: FilesCursor | undefined
  if (query.cursor) {
    const decoded = decodeFilesCursor(query.cursor)
    // Malformed or tampered, not merely "unrecognized" — decodeFilesCursor()
    // does no database lookup (see its own comment), so the only way to get
    // null here is a token that doesn't decode to the expected shape at all.
    // A clean 400 beats silently falling back to page 1, which would look
    // like pagination working while quietly repeating rows on the client.
    if (!decoded) {
      throw createError({
        statusCode: 400,
        message: 'That cursor is invalid.',
        data: { code: 'invalid_cursor' },
      })
    }
    cursor = decoded
  }

  const limit = query.limit ?? 20
  const rows = await listFiles(db, user.id, { limit, cursor })
  const lastRow = rows.at(-1)

  return {
    files: rows.map(toFileView),
    // The client's cue to ask for another page: pass this back as `cursor`.
    // Absent once a page comes back short of the limit — there's nothing
    // older left to ask for.
    nextCursor:
      rows.length === limit && lastRow
        ? encodeFilesCursor({ createdAt: lastRow.createdAt, id: lastRow.id })
        : null,
  }
})
