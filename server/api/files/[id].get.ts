// GET /api/files/:id — stream one of the caller's own files.
//
// ── How a "private" object gets served ───────────────────────────────────────
// R2 objects written by this feature have no public URL: `hub.blob`'s
// Cloudflare driver never configures a public bucket domain (there is no
// `url` on the BlobObject this app ever gets back from `blob.put()`), so the
// worker binding used here — reachable only from server code — is the only
// way any request ever reaches the bytes. That makes this endpoint itself
// the access-control boundary: `requireSubscription()` for "paying
// customer," then an ownership check scoped to `userId` for "your own
// file." No signed URL or short-lived token is layered on top, because
// there is no direct path to the object that either would be protecting
// against — the alternative to this endpoint isn't a leakier URL, it's no
// access at all. `blob.serve()` is the honest read of the docs: it's built
// to be returned straight from a handler that has already decided the
// request may see this object, which is exactly the shape of the check
// above.
//
// Never accepts an `r2Key` from the caller — only the row `id`, looked up
// and ownership-checked first. See server/db/schema.ts › `files` for why
// that matters.

import { z } from 'zod'

const paramsSchema = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { user } = await requireSubscription(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  const file = await getFileById(db, id, user.id)
  // A missing row and someone else's row read identically: 404 either way,
  // so this endpoint can't be used to probe which file ids exist.
  if (!file) throw createError({ statusCode: 404, message: 'File not found' })

  // A `pending` row has no object behind it yet — still mid-upload, or the
  // blob.put() that would have completed it failed (server/api/files/index.post.ts).
  // Either way there is nothing in R2 to stream, so this is a 404 rather
  // than a request that hangs on a missing object.
  if (file.status !== 'uploaded') {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  // PDFs are forced to download rather than render in-browser — see
  // dispositionForMimeType() (server/utils/files.ts) for why an `inline`
  // PDF at this app's origin is a bigger risk than an `inline` image.
  setHeader(
    event,
    'Content-Disposition',
    contentDispositionValue(file.filename, dispositionForMimeType(file.mimeType)),
  )
  return blob.serve(event, file.r2Key)
})
