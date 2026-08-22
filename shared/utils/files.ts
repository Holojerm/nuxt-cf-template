// Upload limits and the type allowlist for the R2 upload feature — pure
// constants and pure functions shared by the server route that enforces them
// (server/api/files/index.post.ts) and the client that pre-checks a file
// before spending a round trip on it (app/components/Upload/FileUpload.vue).
//
// The client-side check is a UX courtesy, not the boundary. Two different
// things happen server-side, and it matters which one is which:
//
//   - `ensureBlob()` re-checks the CLAIM: the size and Content-Type the
//     multipart form declared, against these same constants. A modified
//     client that skips the check below can't send a bigger file or an
//     unlisted declared type.
//   - `sniffMimeType()` (server/utils/files.ts) re-checks the BYTES: it reads
//     the file's own magic-number header and requires it to match the
//     declared type. `ensureBlob()` alone does not do this — `blob.type` is
//     just the part header the client wrote, so a client can declare
//     `image/png` on any bytes it likes unless something looks at the bytes
//     themselves. See server/api/files/index.post.ts for both checks.
//
// Lives in shared/ rather than server/utils/files.ts for the same reason
// shared/utils/site.ts does — both app/ and server/ need the identical
// answer to "is this file allowed," or the client's pre-check and the
// server's real check could disagree about what gets rejected.

/**
 * 8 MB, as a byte count — for client-side pre-checks and Zod validation.
 *
 * Not a round "10 MB": `ensureBlob()`'s size string is typed as
 * `${PowOf2}${Unit}` (@nuxthub/core's `BlobSize`) — a power-of-two count
 * only, so "10MB" is a type error there. 8 MB is the nearest valid size at
 * or under a plain 10 MB target, and MAX_FILE_SIZE_LABEL below is that same
 * number in ensureBlob()'s own format — the two are asserted to agree in
 * test/files.test.ts so they can never drift apart.
 */
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024

/** The limit above, in `ensureBlob()`'s own size-string format. */
export const MAX_FILE_SIZE_LABEL = '8MB'

/**
 * Per-user cap on the number of `files` rows, checked by the POST route
 * before it writes anything (server/utils/files.ts › `isFilesQuotaExceeded()`).
 * `requireSubscription` alone bounds who can upload, not how much — without
 * this, one subscriber can loop 8 MB uploads indefinitely, since neither
 * `MAX_FILE_SIZE_BYTES` nor the rate limit caps the total. 200 is generous
 * for the kind of files this feature accepts (documents and images, not a
 * bulk store) and cheap to raise later — it costs nothing until someone
 * actually hits it.
 */
export const MAX_FILES_PER_USER = 200

/**
 * The only MIME types this feature accepts. Exact strings, not the `image`
 * short-type ensureBlob() also understands — an explicit allowlist here is
 * what keeps "what can a customer upload" answerable by reading one array,
 * not by reasoning about a wildcard.
 */
export const ALLOWED_FILE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number]

/**
 * Extension used to build the R2 key (`server/utils/files.ts` ›
 * `buildR2Key()`). Deliberately keyed off the *validated* MIME type rather
 * than parsed from the client-supplied filename — a filename's extension is
 * whatever the caller typed, which is exactly the input the key-builder must
 * not trust (server/db/schema.ts › `files`).
 */
export const FILE_TYPE_EXTENSIONS: Record<AllowedFileType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/** `accept` attribute value for `<input type="file">` / `UFileUpload`. */
export const ALLOWED_FILE_TYPES_ACCEPT = ALLOWED_FILE_TYPES.join(',')

export function isAllowedFileType(mimeType: string): mimeType is AllowedFileType {
  return (ALLOWED_FILE_TYPES as readonly string[]).includes(mimeType)
}

/** `1.4 MB`, `812 KB`, `3 B` — for the file list and the pre-check hint. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}

// ── Wire shape ────────────────────────────────────────────────────────────────
//
// The JSON a file row serializes to on the wire — used by both
// server/utils/files.ts (toFileView() builds one from a `FileRecord`, which
// pulls in Drizzle's inferred types and so has to stay server-only) and
// app/pages/files.vue / app/components/Upload/FileUpload.vue (typing what
// GET/POST /api/files actually return). Living here, not in
// server/utils/files.ts, is what lets the client import the shape without
// importing anything server-only — the same split shared/utils/blog.ts makes
// for `BlogPostSummary`.

/** The two states a row can be in — see the `status` column's comment in schema.ts. */
export const FILE_STATUSES = ['pending', 'uploaded'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]

export interface FileView {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: FileStatus
  createdAt: string
  updatedAt: string
}
