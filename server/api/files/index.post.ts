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
//
// ── Two independent abuse controls ───────────────────────────────────────────
// requireSubscription only answers "may this account upload at all" — it
// says nothing about how often or how much. rateLimit() below bounds the
// former (bursts), isFilesQuotaExceeded() bounds the latter (accumulation).
// Neither substitutes for the other: a caller patient enough to stay under
// the rate limit could otherwise grow an unbounded number of rows, and a
// caller under the row cap could still hammer the endpoint in a burst.

import { ALLOWED_FILE_TYPES, MAX_FILE_SIZE_LABEL, MAX_FILES_PER_USER } from '#shared/utils/files'

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)

  // 20/60s does NOT match NATIVE_LIMITER's (30, 60) (server/utils/rate-limit.ts),
  // so chooseBackend() routes this to the KV fallback rather than Cloudflare's
  // native binding — expected and fine here: this is routine abuse control on
  // an authenticated, already-metered surface, not the login-form case the
  // native binding exists for. Keyed on the user, not the caller's IP: this is
  // a per-SUBSCRIBER budget (the threat is one account looping uploads), and
  // IP-keying would either under-count a shared IP or over-count one behind a
  // NAT/VPN with several unrelated users on it.
  await rateLimit(event, {
    name: 'file-upload',
    limit: 20,
    windowSeconds: 60,
    identifier: user.id,
  })

  // Checked before anything is written — a standing cap on accumulation,
  // independent of the rate limit above (see the file header). 403, not 429:
  // this isn't "slow down," it's "you're at the limit," and it won't clear on
  // its own the way a rate-limit window does.
  if (await isFilesQuotaExceeded(db, user.id)) {
    throw createError({
      statusCode: 403,
      message: `You've reached the ${MAX_FILES_PER_USER}-file limit. Delete something before uploading more.`,
      data: { code: 'file_quota_exceeded', limit: MAX_FILES_PER_USER },
    })
  }

  const form = await readFormData(event)
  const file = form.get('file')
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, message: 'Missing file' })
  }

  // Validate the claimed shape before touching R2 at all. safeParse, not a
  // bare .parse() — a client mistake here (wrong field type, unlisted MIME
  // type, an oversized or zero `size` the browser itself reported) is a 400,
  // not an uncaught exception the framework turns into a 500. The shape
  // mirrors what h3's readValidatedBody() produces on a thrown ZodError
  // (server/api/*.ts elsewhere gets this for free from that helper; a
  // multipart body has no JSON to hand it, so this route reconstructs the
  // same 400 by hand).
  const parsedMeta = fileMetaSchema.safeParse({
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  })
  if (!parsedMeta.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Validation Error',
      message: parsedMeta.error.message,
      data: parsedMeta.error,
    })
  }
  const meta = parsedMeta.data

  // ensureBlob() re-checks the CLAIM — the live Blob's own `.size`/`.type`,
  // which can differ from what the multipart metadata above reported if a
  // browser mis-reports either. It does NOT look at the file's bytes.
  ensureBlob(file, { maxSize: MAX_FILE_SIZE_LABEL, types: [...ALLOWED_FILE_TYPES] })

  // sniffMimeType() re-checks the BYTES. `blob.type`/`file.type` is just the
  // Content-Type header the client wrote into the multipart part — nothing
  // stops a client declaring `image/png` on any bytes it likes. Reading the
  // file's own magic-number header and requiring it to agree with the
  // declared type is what makes the allowlist actually mean "these file
  // formats," not "these declared strings." A file too short to contain any
  // known signature sniffs as null, which mismatches everything and is
  // rejected the same way.
  const header = new Uint8Array(await file.slice(0, MIME_SNIFF_BYTES).arrayBuffer())
  const sniffed = sniffMimeType(header)
  if (sniffed !== meta.mimeType) {
    throw createError({
      statusCode: 400,
      message: 'That file’s contents don’t match its declared type.',
      data: { code: 'mime_mismatch' },
    })
  }

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
