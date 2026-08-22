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

import { and, desc, eq, lt } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { FileRecord } from '../db/schema'
// Explicit, not the Nitro auto-import: this file is loaded directly by the
// workerd vitest suite, and a shared/ symbol resolves to undefined outside a
// real Nitro request (CLAUDE.md › Gotchas; server/api/referral/me.get.ts
// follows the same rule for the same reason).
import {
  FILE_TYPE_EXTENSIONS,
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
 *   - The result is capped at MAX_FILENAME_LENGTH, preserving the extension
 *     where there is a plausible one, so a very long name still reads as
 *     "the same kind of file" after truncation.
 *   - An empty result (e.g. the input was only path separators) falls back
 *     to the literal string 'file'.
 */
export function sanitizeFilename(rawFilename: string): string {
  const bounded = rawFilename.slice(0, MAX_RAW_FILENAME_LENGTH)
  const lastSegment = bounded.split(/[/\\]/).pop() ?? ''
  const printable = stripControlCharacters(lastSegment).trim()

  if (!printable) return 'file'
  if (printable.length <= MAX_FILENAME_LENGTH) return printable

  const dotIndex = printable.lastIndexOf('.')
  // Only treat it as "the extension" if it's short and not the whole name
  // (a dotfile like `.env` has dotIndex 0, which is not an extension here).
  const hasExtension = dotIndex > 0 && printable.length - dotIndex <= 16
  if (!hasExtension) return printable.slice(0, MAX_FILENAME_LENGTH)

  const extension = printable.slice(dotIndex)
  const stem = printable.slice(0, dotIndex)
  const stemBudget = Math.max(1, MAX_FILENAME_LENGTH - extension.length)
  return `${stem.slice(0, stemBudget)}${extension}`
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

// ── Content-Disposition ──────────────────────────────────────────────────────

/**
 * A `Content-Disposition` header value that hands the browser the file's
 * display name without letting that name break the header. sanitizeFilename()
 * already strips control characters, but a header value still can't contain
 * an unescaped double quote, and non-ASCII characters need the RFC 5987
 * extended form to survive — `filename*` is what lets an emoji or accented
 * filename come through instead of being replaced in the plain fallback.
 */
export function contentDispositionValue(filename: string): string {
  const asciiFallback = stripControlCharacters(filename)
    .replace(/"/g, "'")
    .split('')
    .map((char) => (char.codePointAt(0)! <= 0x7e ? char : '_'))
    .join('')
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
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

export interface ListFilesOptions {
  /** Default 20, capped at 100 — the composite index makes even 100 cheap. */
  limit?: number
  /** The `id` of the last row from a previous page. Rows strictly older follow. */
  cursor?: string
}

/**
 * This user's files, newest first — the one query
 * `files_user_id_created_idx` (server/db/schema.ts) exists to serve.
 *
 * Cursor pagination rather than an offset: an offset re-numbers every row
 * behind an insert, so a second page fetched while someone is actively
 * uploading can skip or repeat rows. A cursor never does, because it names a
 * position ("older than this row") rather than a count.
 */
export async function listFiles(
  db: FilesDb,
  userId: string,
  options: ListFilesOptions = {},
): Promise<FileRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const filters = [eq(tables.files.userId, userId)]

  if (options.cursor) {
    // Scoped to the same user, so a cursor from someone else's list (or a
    // guessed id) can't be used to infer another account's upload times —
    // it just fails to match and the query runs unfiltered by cursor.
    const cursorRow = await db.query.files.findFirst({
      where: and(eq(tables.files.id, options.cursor), eq(tables.files.userId, userId)),
    })
    if (cursorRow) filters.push(lt(tables.files.createdAt, cursorRow.createdAt))
  }

  return db
    .select()
    .from(tables.files)
    .where(and(...filters))
    .orderBy(desc(tables.files.createdAt))
    .limit(limit)
}

/** One file, scoped to its owner — a mismatch reads identically to "no such row." */
export async function getFileById(
  db: FilesDb,
  id: string,
  userId: string,
): Promise<FileRecord | null> {
  const row = await db.query.files.findFirst({
    where: and(eq(tables.files.id, id), eq(tables.files.userId, userId)),
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

// ── Wire shape ────────────────────────────────────────────────────────────────
// `FileView` itself lives in #shared/utils/files — both this file and the
// client need the identical shape. See that file's own comment for why.

/**
 * What the client is allowed to know about a file. Deliberately omits
 * `r2Key` and `userId` — the storage key is an implementation detail (the
 * client never needs it; GET /api/files/:id streams bytes without exposing
 * it) and the owner is implicit in "this came back from your own request."
 */
export function toFileView(row: FileRecord): FileView {
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
