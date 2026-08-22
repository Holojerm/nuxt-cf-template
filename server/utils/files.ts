// Row-level operations for the `files` table (server/db/schema.ts), plus the
// two pure functions that keep the storage-key invariant true: every R2 key
// this feature ever writes starts with `uploads/<user_id>/`, and never with
// anything a client sent.
//
// Like server/utils/entitlements.ts and server/utils/feedback.ts, every
// function here takes the Drizzle client as its first argument rather than
// reaching for the auto-imported `db`, so test/files.test.ts can drive this
// against a real D1 binding without booting Nitro. The R2 calls themselves
// (`blob.put`, `blob.serve`, `blob.del`) stay in server/api/files/*.ts — they
// need a real R2 binding and Nitro's request context, neither of which this
// file has access to, and keeping them out of here is what makes everything
// below testable with no bucket at all.

import { and, count, desc, eq, lt, or } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import { z } from 'zod'
import * as tables from '../db/schema'
import type { FileRecord } from '../db/schema'
// Explicit, not the Nitro auto-import: this file is loaded directly by the
// workerd vitest suite, and a shared/ symbol resolves to undefined outside a
// real Nitro request (CLAUDE.md › Gotchas; server/api/referral/me.get.ts
// follows the same rule for the same reason).
import {
  ALLOWED_FILE_TYPES,
  FILE_TYPE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_USER,
  type AllowedFileType,
  type FileStatus,
  type FileView,
} from '#shared/utils/files'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type FilesDb = ReturnType<typeof drizzle<typeof tables>>

// ── Filename sanitizing ──────────────────────────────────────────────────────

/**
 * Cap on the sanitized filename stored in `files.filename`. Generous enough
 * for any real document name, short enough that it can't be used to bloat a
 * row or overflow a UI that renders it inline.
 */
export const MAX_FILENAME_LENGTH = 150

/**
 * Cap on the *raw* filename this function will even look at, before any of
 * the cleanup below runs. Not a real limit on anything — just a refusal to
 * scan an arbitrarily long string a client could send in the multipart
 * form's filename field.
 */
export const MAX_RAW_FILENAME_LENGTH = 1024

/**
 * True for the ASCII control characters (0x00–0x1F) and DEL (0x7F). Written
 * as a code-point check rather than a hardcoded regex range, so the
 * control characters this function exists to remove are never themselves
 * typed into source — a regex literal full of raw control bytes is exactly
 * the kind of thing that looks fine in an editor and is wrong on disk.
 */
function isControlCharacter(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f
}

/** Drop every ASCII control character (including NUL) from a string. */
function stripControlCharacters(input: string): string {
  let result = ''
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0
    if (!isControlCharacter(codePoint)) result += char
  }
  return result
}

/** Number of Unicode code points, not UTF-16 units — so a surrogate-pair
 *  character (most emoji) counts once, matching how MAX_FILENAME_LENGTH is
 *  meant to be read. */
function codePointLength(input: string): number {
  return [...input].length
}

/**
 * Truncate to at most `maxLength` Unicode code points, never splitting a
 * surrogate pair in two. A plain `.slice(0, n)` operates on UTF-16 code
 * units — for a string containing astral characters (most emoji), slicing
 * through the middle of a pair leaves a lone surrogate in the result, and a
 * lone surrogate later crashes `encodeURIComponent()`. That crash used to
 * happen in contentDispositionValue() below on every GET for the row this
 * produced — silent at upload time, permanent afterward — so the fix
 * belongs here, at the point that creates the string, even though
 * contentDispositionValue() now also guards itself as a second layer.
 */
function truncateToCodePoints(input: string, maxLength: number): string {
  // Fast path: UTF-16 length is never less than the code point count, so if
  // even the (always-larger-or-equal) UTF-16 length already fits, there's
  // nothing to truncate — and no need to spread a string that's already short.
  if (input.length <= maxLength) return input
  return [...input].slice(0, maxLength).join('')
}

/**
 * Turn whatever a client claims a file is named into something safe to store
 * and render: display-only, matching the `files.filename` column comment in
 * schema.ts — this value is NEVER used to build `r2_key` (see buildR2Key()
 * below), so nothing here has to be safe as a path component, only as text.
 *
 *   - Only the last path segment survives, so `../../etc/passwd` or a
 *     leftover full path from a confused client becomes `passwd`, not a
 *     traversal attempt sitting in a database column.
 *   - Control characters (including NUL) are stripped — they can't render
 *     safely and are a log/terminal injection vector if this value ever ends
 *     up in a log line or a Content-Disposition header (see
 *     contentDispositionValue() below).
 *   - The result is capped at MAX_FILENAME_LENGTH **code points**, preserving
 *     the extension where there is a plausible one, so a very long name
 *     still reads as "the same kind of file" after truncation — and every
 *     truncation goes through truncateToCodePoints() above, never a raw
 *     `.slice()`, so a run of emoji can't be cut mid-character.
 *   - An empty result (e.g. the input was only path separators) falls back
 *     to the literal string 'file'.
 */
export function sanitizeFilename(rawFilename: string): string {
  const bounded = truncateToCodePoints(rawFilename, MAX_RAW_FILENAME_LENGTH)
  const lastSegment = bounded.split(/[/\\]/).pop() ?? ''
  const printable = stripControlCharacters(lastSegment).trim()

  if (!printable) return 'file'
  if (codePointLength(printable) <= MAX_FILENAME_LENGTH) return printable

  const dotIndex = printable.lastIndexOf('.')
  // Only treat it as "the extension" if it's short and not the whole name
  // (a dotfile like `.env` has dotIndex 0, which is not an extension here).
  const hasExtension = dotIndex > 0 && codePointLength(printable.slice(dotIndex)) <= 16
  if (!hasExtension) return truncateToCodePoints(printable, MAX_FILENAME_LENGTH)

  const extension = printable.slice(dotIndex)
  const stem = printable.slice(0, dotIndex)
  const stemBudget = Math.max(1, MAX_FILENAME_LENGTH - codePointLength(extension))
  return `${truncateToCodePoints(stem, stemBudget)}${extension}`
}

// ── R2 key construction ──────────────────────────────────────────────────────

/**
 * Build the R2 key a newly uploaded file is stored at:
 * `uploads/<user_id>/<uuid>.<ext>`.
 *
 * The only inputs are `userId` (the session's own id — never a caller-
 * supplied route param) and `mimeType` (already checked against the
 * allowlist by ensureBlob() before this runs). Neither is attacker-
 * controlled in the way a filename is, so nothing here can construct a key
 * outside the caller's own `uploads/<user_id>/` prefix — the invariant the
 * `files` table's comment in server/db/schema.ts documents and this
 * function is what enforces it. Deliberately NOT built from the client's
 * filename, sanitized or not: a filename is display text, not a path
 * component, and keeping the two derivations independent is what makes
 * that true even if sanitizeFilename() above ever grows a bug.
 */
export function buildR2Key(userId: string, mimeType: AllowedFileType): string {
  const id = crypto.randomUUID()
  const extension = FILE_TYPE_EXTENSIONS[mimeType]
  return `uploads/${userId}/${id}.${extension}`
}

// ── MIME sniffing ─────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] // "RIFF", offset 0 of a WebP container
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] // "WEBP", offset 8 of the same container

/**
 * How many leading bytes sniffMimeType() needs to have seen. The RIFF/WebP
 * check reaches furthest — 4 bytes starting at offset 8 — so callers should
 * read at least this many bytes off the file's head before calling it.
 */
export const MIME_SNIFF_BYTES = 16

function matchesSignature(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * Identify a file by its own magic-number header, not by what the client's
 * multipart form claimed. `ensureBlob()` (called in the POST route) only
 * checks the declared `blob.type` — the Content-Type header a client wrote
 * into the form part — which is exactly the kind of thing a client
 * controls unilaterally, no different from a filename. This looks at the
 * bytes themselves. Returns null when they match none of the allowed
 * types (including a file too short to contain any signature) — the caller
 * treats that identically to a declared/sniffed mismatch (see
 * server/api/files/index.post.ts), since "unrecognized" and "wrong" both
 * mean the same thing here: don't trust the declared type.
 */
export function sniffMimeType(bytes: Uint8Array): AllowedFileType | null {
  if (matchesSignature(bytes, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesSignature(bytes, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesSignature(bytes, 0, PDF_SIGNATURE)) return 'application/pdf'
  if (matchesSignature(bytes, 0, RIFF_SIGNATURE) && matchesSignature(bytes, 8, WEBP_SIGNATURE)) {
    return 'image/webp'
  }
  return null
}

// ── Upload metadata validation ───────────────────────────────────────────────

/**
 * What the POST route checks a multipart file's own metadata against,
 * before anything touches R2 — exported (rather than defined inline in the
 * route) so test/files.test.ts can exercise it directly, and so the route
 * has one thing to call: `fileMetaSchema.safeParse(...)`. A bare `.parse()`
 * here used to turn any client mistake — a missing filename, an unlisted
 * MIME type, an oversized declared size, including a 0-byte file (excluded
 * by `.positive()` below) — into an uncaught 500 instead of a 400. See
 * server/api/files/index.post.ts.
 */
export const fileMetaSchema = z.object({
  filename: z.string().min(1).max(MAX_RAW_FILENAME_LENGTH),
  mimeType: z.enum(ALLOWED_FILE_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
})

export type FileMeta = z.infer<typeof fileMetaSchema>

// ── Content-Disposition ──────────────────────────────────────────────────────

/**
 * `attachment` for anything that isn't an image — today, that's PDFs.
 * `blob.serve()` streams raw bytes with no sandboxing, so an `inline` PDF is
 * handed to the browser's own PDF viewer, rendered at this app's origin. A
 * PDF is a full document format with its own script/action model, so that
 * makes an uploaded PDF attacker-authored content wearing this domain's
 * identity. Images have no comparable execution surface, so they keep the
 * better default of opening in the tab instead of forcing a download.
 */
export function dispositionForMimeType(mimeType: string): 'inline' | 'attachment' {
  return mimeType === 'application/pdf' ? 'attachment' : 'inline'
}

/** ASCII-only rendering of `filename` for the plain `filename=` fallback —
 *  spread by code point (not `.split('')`, which is UTF-16 units) so a
 *  surrogate pair collapses to one `_`, not two, and a genuinely lone
 *  surrogate (which the string iterator yields as its own element rather
 *  than throwing) still resolves to a single safe replacement character. */
function toAsciiFallback(filename: string): string {
  const printable = stripControlCharacters(filename).replace(/"/g, "'")
  return [...printable].map((char) => (char.codePointAt(0)! <= 0x7e ? char : '_')).join('')
}

/**
 * A `Content-Disposition` header value that hands the browser the file's
 * display name without letting that name break the header. sanitizeFilename()
 * already strips control characters, but a header value still can't contain
 * an unescaped double quote, and non-ASCII characters need the RFC 5987
 * extended form to survive — `filename*` is what lets an emoji or accented
 * filename come through instead of being replaced in the plain fallback.
 *
 * This function CANNOT throw, by construction — it used to, when `filename`
 * contained a lone UTF-16 surrogate: `encodeURIComponent()` raises a
 * `URIError` on one, and a pre-fix build of sanitizeFilename() could produce
 * exactly that by truncating mid-surrogate-pair (see truncateToCodePoints()
 * above, which is the actual fix — this is the second layer, for any row a
 * build before that fix already wrote). The bug that created was silent at
 * upload time and permanent afterward: the row saved fine, and every GET on
 * it 500'd forever, because this function runs on every request, not just
 * the first. The try/catch below is what makes that impossible regardless
 * of how a bad surrogate reached this argument.
 */
export function contentDispositionValue(
  filename: string,
  disposition: 'inline' | 'attachment' = 'inline',
): string {
  const asciiFallback = toAsciiFallback(filename)

  let encoded: string
  try {
    encoded = encodeURIComponent(filename)
  } catch {
    // toAsciiFallback() only ever emits code points <= 0x7E, so it can never
    // contain a lone surrogate — this can't throw a second time.
    encoded = encodeURIComponent(asciiFallback)
  }

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

// ── Row operations ───────────────────────────────────────────────────────────

export interface NewFileInput {
  userId: string
  /** Sanitized display name — pass through sanitizeFilename() first. */
  filename: string
  mimeType: AllowedFileType
  sizeBytes: number
  r2Key: string
}

/**
 * Insert a `pending` row. Called BEFORE the object is written to R2 — see
 * the `status` column's comment in schema.ts and the ordering note in
 * server/api/files/index.post.ts. A row that never reaches `uploaded` is an
 * abandoned upload, not a lie about what's in the bucket.
 */
export async function createFileRecord(db: FilesDb, input: NewFileInput): Promise<FileRecord> {
  const [row] = await db
    .insert(tables.files)
    .values({
      userId: input.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      r2Key: input.r2Key,
      status: 'pending',
    })
    .returning()
  if (!row) throw new Error('files insert returned no row')
  return row
}

/**
 * Flip a row to `uploaded` once blob.put() has confirmed the object landed.
 * Scoped to `userId` like every other lookup here — not because a caller
 * could otherwise guess another user's file id and flip it (only the upload
 * route calls this, immediately after creating the row it names), but so
 * the scoping rule has no exception to remember.
 */
export async function markUploaded(
  db: FilesDb,
  id: string,
  userId: string,
): Promise<FileRecord | null> {
  const [row] = await db
    .update(tables.files)
    .set({ status: 'uploaded' })
    .where(and(eq(tables.files.id, id), eq(tables.files.userId, userId)))
    .returning()
  return row ?? null
}

// ── Pagination cursor ─────────────────────────────────────────────────────────

/** What a `files` list cursor names: a row's position in the (createdAt,
 *  id) total order — see listFiles() below for why both fields, not just
 *  one, are needed to make that position unambiguous. */
export interface FilesCursor {
  createdAt: Date
  id: string
}

/** The decoded shape a cursor token must match — anything else (malformed
 *  base64, malformed JSON, or JSON of the wrong shape) is a tampered or
 *  hand-crafted token, not a real cursor. */
const cursorPayloadSchema = z.object({
  // Epoch seconds, matching the `created_at` column's own storage
  // granularity (D1 timestamps round-trip through `Date` at second
  // precision) — the cursor can't claim a precision the row never had.
  t: z.number().int().nonnegative(),
  id: z.string().min(1).max(200),
})

/** Base64url, no padding — safe in a query string with no extra encoding. */
function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return atob(padded)
}

/**
 * Encode a page boundary as an opaque, self-describing token — the `id` of
 * the last row on a page is NOT enough on its own (see the mismatch this
 * replaced, below), so this carries `createdAt` too.
 */
export function encodeFilesCursor(cursor: FilesCursor): string {
  const payload = JSON.stringify({
    t: Math.floor(cursor.createdAt.getTime() / 1000),
    id: cursor.id,
  })
  return toBase64Url(payload)
}

/**
 * Decode a token produced by encodeFilesCursor(). Null for anything that
 * doesn't decode to the expected shape — the caller (GET /api/files) turns
 * that into a 400 rather than silently mis-paginating. Deliberately does
 * NOT look the row up in the database: a lookup-based cursor (resolve the
 * id, read its `createdAt`) fails exactly when it matters most — when that
 * row has since been deleted, which silently drops the filter and restarts
 * the list at page 1 instead of continuing from where the caller left off.
 * Encoding the position directly means there is nothing to look up, so a
 * deleted cursor row can't do that.
 */
export function decodeFilesCursor(raw: string): FilesCursor | null {
  let json: string
  try {
    json = fromBase64Url(raw)
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const result = cursorPayloadSchema.safeParse(parsed)
  if (!result.success) return null

  return { createdAt: new Date(result.data.t * 1000), id: result.data.id }
}

// ── Row operations ───────────────────────────────────────────────────────────

/** Everything listFiles() returns — every field toFileView() reads, and
 *  nothing else. Never `r2Key` (the list view has no use for a storage
 *  key) or `userId` (the query is already scoped to one user) — see
 *  getFileById() below for the single-file route's narrower exclusion. */
export type FileListRow = Pick<
  FileRecord,
  'id' | 'filename' | 'mimeType' | 'sizeBytes' | 'status' | 'createdAt' | 'updatedAt'
>

export interface ListFilesOptions {
  /** Default 20, capped at 100 — the composite index makes even 100 cheap. */
  limit?: number
  /** The position of the last row from a previous page — see FilesCursor. */
  cursor?: FilesCursor
}

/**
 * This user's files, newest first — the one query
 * `files_user_id_created_idx` (server/db/schema.ts) exists to serve.
 *
 * Cursor pagination rather than an offset: an offset re-numbers every row
 * behind an insert, so a second page fetched while someone is actively
 * uploading can skip or repeat rows. A cursor never does, because it names a
 * position ("older than this row") rather than a count.
 *
 * Keyed on `(created_at, id)`, not `created_at` alone. D1 timestamps are
 * epoch SECONDS, so any two uploads in the same second are indistinguishable
 * by `created_at` — a plain `created_at < cursor` filter would silently
 * drop whichever of a tied pair wasn't the cursor row. `id` is an arbitrary
 * but total tie-breaker: arbitrary because ids are random UUIDs with no
 * inherent order, total because SQLite's default TEXT collation orders any
 * two distinct strings consistently, and this function applies that same
 * order in both the WHERE filter and the ORDER BY — so the sequence a
 * cursor was cut from is exactly the sequence it resumes.
 */
export async function listFiles(
  db: FilesDb,
  userId: string,
  options: ListFilesOptions = {},
): Promise<FileListRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const filters = [eq(tables.files.userId, userId)]

  if (options.cursor) {
    const { createdAt, id } = options.cursor
    filters.push(
      or(
        lt(tables.files.createdAt, createdAt),
        and(eq(tables.files.createdAt, createdAt), lt(tables.files.id, id)),
      )!,
    )
  }

  return db
    .select({
      id: tables.files.id,
      filename: tables.files.filename,
      mimeType: tables.files.mimeType,
      sizeBytes: tables.files.sizeBytes,
      status: tables.files.status,
      createdAt: tables.files.createdAt,
      updatedAt: tables.files.updatedAt,
    })
    .from(tables.files)
    .where(and(...filters))
    .orderBy(desc(tables.files.createdAt), desc(tables.files.id))
    .limit(limit)
}

/** Everything getFileById() returns — the full row minus `userId`, which
 *  the WHERE clause below already scoped the lookup to. Unlike
 *  FileListRow, this keeps `r2Key`: both callers (GET and DELETE
 *  /api/files/:id) need it to talk to R2. */
export type FileRow = Omit<FileRecord, 'userId'>

/** One file, scoped to its owner — a mismatch reads identically to "no such row." */
export async function getFileById(
  db: FilesDb,
  id: string,
  userId: string,
): Promise<FileRow | null> {
  const row = await db.query.files.findFirst({
    where: and(eq(tables.files.id, id), eq(tables.files.userId, userId)),
    columns: { userId: false },
  })
  return row ?? null
}

/**
 * Delete the row. Callers decide the order relative to blob.del() — see
 * server/api/files/[id].delete.ts for why the object is removed first.
 */
export async function deleteFileRecord(
  db: FilesDb,
  id: string,
  userId: string,
): Promise<FileRecord | null> {
  const [row] = await db
    .delete(tables.files)
    .where(and(eq(tables.files.id, id), eq(tables.files.userId, userId)))
    .returning()
  return row ?? null
}

/**
 * How many rows this user owns, `pending` or `uploaded` — the number
 * isFilesQuotaExceeded() below checks against MAX_FILES_PER_USER. Counts
 * both statuses deliberately: a burst of concurrent uploads should not be
 * able to slip past the cap on the strength of rows that haven't resolved
 * to `uploaded` yet.
 */
export async function countFilesForUser(db: FilesDb, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(tables.files)
    .where(eq(tables.files.userId, userId))
  return row?.total ?? 0
}

/**
 * Whether this user has hit MAX_FILES_PER_USER (shared/utils/files.ts) —
 * checked by the POST route before it writes anything, alongside the
 * per-request rate limit. The rate limit bounds how FAST someone can
 * upload; this bounds how MUCH they can accumulate, which the rate limit
 * alone does not — a caller patient enough to stay under it could otherwise
 * grow an unbounded number of rows.
 */
export async function isFilesQuotaExceeded(db: FilesDb, userId: string): Promise<boolean> {
  return (await countFilesForUser(db, userId)) >= MAX_FILES_PER_USER
}

// ── Wire shape ────────────────────────────────────────────────────────────────
// `FileView` itself lives in #shared/utils/files — both this file and the
// client need the identical shape. See that file's own comment for why.

/**
 * What the client is allowed to know about a file. Deliberately omits
 * `r2Key` and `userId` — the storage key is an implementation detail (the
 * client never needs it; GET /api/files/:id streams bytes without exposing
 * it) and the owner is implicit in "this came back from your own request."
 *
 * Takes `FileListRow`, not `FileRecord` — the narrowest shape that has
 * every field this function reads. `createFileRecord`/`markUploaded` still
 * return the full row (a superset, so passing one here is fine); `listFiles`
 * now selects only these columns to begin with, so there is no wider row to
 * narrow at this boundary — the query itself never asks the database for
 * `r2Key` or `userId` in the first place.
 */
export function toFileView(row: FileListRow): FileView {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status as FileStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
