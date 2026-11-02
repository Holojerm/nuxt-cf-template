// DELETE /api/files/:id — remove one of the caller's own files.
//
// ── Why the object is deleted before the row, not after ─────────────────────
// Two failure modes are possible here, and only one of them is recoverable
// by the person who clicked delete:
//
//   - Object first, then row (what this handler does). If blob.del()
//     succeeds but the row delete that follows fails (a D1 hiccup), the
//     file is still listed — its `uploaded` row survives, pointing at an
//     object that's already gone. The owner sees delete "didn't take,"
//     clicks it again, blob.del() runs against an already-missing key (R2's
//     delete is idempotent — it does not error on a key that isn't there),
//     and the row delete succeeds. One retry, no sweeper, no orphan.
//
//   - Row first, then object. A blob.del() failure after that leaves an R2
//     object with nothing in `files` pointing at it — invisible to this
//     API, to the owner's file list, and to any query short of a full
//     bucket scan. server/utils/account.ts › deleteAccount() accepts
//     exactly this trade, but only there: that path is rare, already
//     wrapped in an audit row, and its failure is logged and monitored as
//     the one-time event it is. A per-file delete a user can trigger any
//     number of times a day is the wrong place to create a routinely
//     silent, unrecoverable leak.
//
// So: object first. A failure there is surfaced as a clean error with the
// row untouched, rather than swallowed the way account deletion's
// best-effort blob.del() is.
//
// Not audited — see server/api/admin/users/[id]/grant.post.ts for what
// withAudit() is for. A person deleting their own upload is not a
// privileged action; audit_log exists to record what was done TO an
// account by someone else, not a customer's routine housekeeping.

import { z } from 'zod'

const paramsSchema = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  const file = await getFileById(db, id, user.id)
  if (!file) throw createError({ statusCode: 404, message: 'File not found' })

  try {
    await blob.del(file.r2Key)
  } catch (error) {
    console.error(
      JSON.stringify({ kind: 'file_delete_blob_failed', fileId: file.id, error: String(error) }),
    )
    throw createError({ statusCode: 502, message: 'Could not delete the file — please try again.' })
  }

  await deleteFileRecord(db, file.id, user.id)

  return { deleted: true, id: file.id }
})
