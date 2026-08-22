// POST /api/files — upload a file into the caller's own R2 prefix.
//
// Paid feature: requireSubscription gates it before anything else runs, the
// same boundary every other paid route uses (server/utils/billing.ts). The
// upload is server-mediated — the client posts multipart form data here
// rather than straight to R2 — so this handler is the one place that
// decides the object's key, and the `files` table's invariant (every
// r2_key starts with `uploads/<user_id>/`) never depends on trusting what
// the client sends. See server/db/schema.ts › `files` and
// server/utils/files.ts › buildR2Key().
//
// ── pending -> uploaded ──────────────────────────────────────────────────────
// The row is written before the object exists in R2, and flipped to
// `uploaded` only once blob.put() confirms it landed. A failure between
// those two steps leaves a `pending` row that never got its object — an
// abandoned upload a sweeper can find later, not a row lying about what's
// actually in the bucket.

import { z } from 'zod'
import { ALLOWED_FILE_TYPES, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from '#shared/utils/files'

const fileMetaSchema = z.object({
  filename: z.string().min(1).max(MAX_RAW_FILENAME_LENGTH),
  mimeType: z.enum(ALLOWED_FILE_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)

  const form = await readFormData(event)
  const file = form.get('file')
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, message: 'Missing file' })
  }

  // Validate the claimed shape before touching R2 at all. Zod first, for a
  // clean 400 on an obviously wrong request (wrong field type, unlisted
  // MIME type, an oversized `size` the client itself reported); ensureBlob()
  // second, as the real backstop — it reads the live Blob rather than
  // trusting what the form claimed, catching a browser that mis-reported
  // either value.
  const meta = fileMetaSchema.parse({
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  })
  ensureBlob(file, { maxSize: MAX_FILE_SIZE_LABEL, types: [...ALLOWED_FILE_TYPES] })

  const filename = sanitizeFilename(meta.filename)
  const r2Key = buildR2Key(user.id, meta.mimeType)

  const record = await createFileRecord(db, {
    userId: user.id,
    filename,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    r2Key,
  })

  try {
    await blob.put(r2Key, file, { contentType: meta.mimeType })
  } catch (error) {
    // The row stays `pending` — exactly what that status exists for (see
    // the file header above). Surface a clean failure; the client's retry
    // mints a fresh row and key rather than reusing this one.
    console.error(
      JSON.stringify({ kind: 'file_upload_put_failed', fileId: record.id, error: String(error) }),
    )
    throw createError({ statusCode: 502, message: 'Could not store the file — please try again.' })
  }

  const uploaded = await markUploaded(db, record.id, user.id)
  return toFileView(uploaded ?? record)
})
