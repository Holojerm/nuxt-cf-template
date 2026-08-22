// The R2 upload feature's db-only half, run against a real D1 inside
// workerd. No R2 binding involved — the blob calls live in
// server/api/files/*.ts, not here (server/utils/files.ts's own header
// explains why) — so what this file pins down is everything that doesn't
// need one:
//
//   1. sanitizeFilename() neutralizes a hostile display name, safely even
//      across a surrogate-pair boundary.
//   2. buildR2Key() never accepts a filename at all, so nothing a caller
//      names a file can ever influence the key — the `uploads/<user_id>/`
//      prefix invariant from server/db/schema.ts › `files` holds regardless.
//   3. sniffMimeType() reads magic bytes, not declared claims.
//   4. fileMetaSchema rejects bad upload metadata (missing filename, unlisted
//      type, oversized or zero size) the way the POST route needs it to —
//      as a safeParse() failure, not a thrown exception.
//   5. The row operations are correctly scoped to their owner: one user's
//      list, get, and delete never reach another user's files.
//   6. Cursor pagination survives same-second ties and a deleted cursor row,
//      and a malformed/tampered token decodes to null rather than silently
//      mis-paginating.
//   7. contentDispositionValue() cannot throw, and picks the right
//      disposition for PDFs vs. images.
//   8. isFilesQuotaExceeded() enforces MAX_FILES_PER_USER.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  MAX_FILENAME_LENGTH,
  MIME_SNIFF_BYTES,
  buildR2Key,
  contentDispositionValue,
  countFilesForUser,
  createFileRecord,
  decodeFilesCursor,
  deleteFileRecord,
  dispositionForMimeType,
  encodeFilesCursor,
  fileMetaSchema,
  getFileById,
  isFilesQuotaExceeded,
  listFiles,
  markUploaded,
  sanitizeFilename,
  sniffMimeType,
  toFileView,
} from '../server/utils/files'
import {
  ALLOWED_FILE_TYPES,
  FILE_TYPE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  MAX_FILES_PER_USER,
} from '../shared/utils/files'

const db = drizzle(env.DB, { schema })

const USER = 'user-1'
const OTHER = 'user-2'

async function makeUser(id: string) {
  await db
    .insert(schema.users)
    .values({ id, email: `${id}@example.com`, name: id })
    .onConflictDoNothing()
}

/** D1 timestamp columns are epoch seconds — rows inserted back-to-back in the
 *  same test tie on `created_at` unless backdated explicitly. */
async function backdate(id: string, createdAt: Date) {
  await db.update(schema.files).set({ createdAt }).where(eq(schema.files.id, id))
}

/** A row shaped enough to satisfy createFileRecord(), for one call site less
 *  boilerplate across the tests below. */
function newFileInput(userId: string, filename: string) {
  return {
    userId,
    filename,
    mimeType: 'application/pdf' as const,
    sizeBytes: 10,
    r2Key: buildR2Key(userId, 'application/pdf'),
  }
}

beforeEach(async () => {
  await db.delete(schema.files)
  await db.delete(schema.users)
  await makeUser(USER)
  await makeUser(OTHER)
})

describe('sanitizeFilename', () => {
  it('keeps an ordinary filename unchanged', () => {
    expect(sanitizeFilename('quarterly-report.pdf')).toBe('quarterly-report.pdf')
  })

  it('drops everything before the last path segment', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('..\\..\\Windows\\System32\\config')).toBe('config')
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd')
  })

  it('strips control characters, including NUL', () => {
    const withNul = `evil${String.fromCharCode(0)}name.png`
    expect(sanitizeFilename(withNul)).toBe('evilname.png')

    const withNewline = 'report.pdf\nSet-Cookie: hijacked=1'
    expect(sanitizeFilename(withNewline)).not.toMatch(/[\n\r]/)
  })

  it('falls back to "file" when nothing printable survives', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('/')).toBe('file')
    expect(sanitizeFilename(String.fromCharCode(0, 1, 2))).toBe('file')
  })

  it('caps length while preserving a short extension', () => {
    const long = `${'a'.repeat(500)}.pdf`
    const result = sanitizeFilename(long)
    expect(result.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
    expect(result.endsWith('.pdf')).toBe(true)
  })

  it('truncates a name with no plausible extension without erroring', () => {
    const long = 'a'.repeat(2000)
    const result = sanitizeFilename(long)
    expect(result.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
  })

  it('truncates a run of astral characters without splitting a surrogate pair', () => {
    // The exact regression this guards against: a plain `.slice()` on
    // UTF-16 indices can cut an emoji's surrogate pair in half, leaving a
    // lone surrogate in the result. That string then crashes
    // `encodeURIComponent()` — see the contentDispositionValue() tests
    // below for what that did downstream.
    const hostile = 'a' + '😀'.repeat(100)
    const result = sanitizeFilename(hostile)

    // No lone surrogate anywhere in the result: every UTF-16 code unit in
    // the high-surrogate range must be immediately followed by one in the
    // low-surrogate range.
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
      if (isHighSurrogate) {
        const next = result.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
    }

    // And, the actual downstream failure mode: building a
    // Content-Disposition header from the result must not throw.
    expect(() => contentDispositionValue(result)).not.toThrow()
  })
})

describe('buildR2Key', () => {
  it('always starts with uploads/<user_id>/', () => {
    for (const mimeType of ALLOWED_FILE_TYPES) {
      const key = buildR2Key(USER, mimeType)
      expect(key.startsWith(`uploads/${USER}/`)).toBe(true)
    }
  })

  it('ends with the extension for the given MIME type', () => {
    for (const mimeType of ALLOWED_FILE_TYPES) {
      const key = buildR2Key(USER, mimeType)
      expect(key.endsWith(`.${FILE_TYPE_EXTENSIONS[mimeType]}`)).toBe(true)
    }
  })

  it('never produces the same key twice', () => {
    const keys = new Set(Array.from({ length: 20 }, () => buildR2Key(USER, 'image/png')))
    expect(keys.size).toBe(20)
  })

  it('takes no filename argument, so a hostile filename can never reach the key', () => {
    // buildR2Key()'s signature is (userId, mimeType) — there is no third
    // argument a caller could use to inject a path segment. This test exists
    // to keep it that way: if a future change ever threaded the client's
    // filename through to this function, this assertion is what would need
    // to be rewritten to accommodate it, which is the point.
    expect(buildR2Key.length).toBe(2)

    const hostileFilename = '../../../../etc/passwd'
    const sanitized = sanitizeFilename(hostileFilename)
    const key = buildR2Key(USER, 'application/pdf')

    // The sanitized display name never appears in the storage key.
    expect(key.includes(sanitized)).toBe(false)
    expect(key.includes('..')).toBe(false)
    expect(key.startsWith(`uploads/${USER}/`)).toBe(true)
  })

  it('scopes different users to different prefixes', () => {
    const mine = buildR2Key(USER, 'image/jpeg')
    const theirs = buildR2Key(OTHER, 'image/jpeg')
    expect(mine.startsWith(`uploads/${USER}/`)).toBe(true)
    expect(theirs.startsWith(`uploads/${OTHER}/`)).toBe(true)
    expect(mine.startsWith(`uploads/${OTHER}/`)).toBe(false)
  })
})

describe('sniffMimeType', () => {
  // Real magic-number headers, padded to MIME_SNIFF_BYTES with arbitrary
  // trailing bytes — sniffMimeType() never looks past what each signature
  // needs, so the padding's actual values don't matter.
  const pad = (bytes: number[]): Uint8Array => {
    const out = new Uint8Array(MIME_SNIFF_BYTES)
    out.set(bytes.slice(0, MIME_SNIFF_BYTES))
    return out
  }

  const PNG_HEADER = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const JPEG_HEADER = pad([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const PDF_HEADER = pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  const WEBP_HEADER = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const UNKNOWN_HEADER = pad([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  it('identifies each allowed type from its magic bytes', () => {
    expect(sniffMimeType(PNG_HEADER)).toBe('image/png')
    expect(sniffMimeType(JPEG_HEADER)).toBe('image/jpeg')
    expect(sniffMimeType(PDF_HEADER)).toBe('application/pdf')
    expect(sniffMimeType(WEBP_HEADER)).toBe('image/webp')
  })

  it('returns null for bytes matching none of the allowed types', () => {
    expect(sniffMimeType(UNKNOWN_HEADER)).toBeNull()
    expect(sniffMimeType(new Uint8Array(0))).toBeNull()
  })

  it("flags a mismatch between a declared type and the sniffed one — the POST route's exact check", () => {
    const declaredMimeType = 'image/png'
    const actualBytes = PDF_HEADER // a PDF renamed/relabeled as a PNG
    expect(sniffMimeType(actualBytes)).not.toBe(declaredMimeType)
  })
})

describe('fileMetaSchema', () => {
  it('accepts a well-formed upload', () => {
    const result = fileMetaSchema.safeParse({
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a 0-byte file', () => {
    const result = fileMetaSchema.safeParse({
      filename: 'empty.png',
      mimeType: 'image/png',
      sizeBytes: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unlisted MIME type', () => {
    const result = fileMetaSchema.safeParse({
      filename: 'script.js',
      mimeType: 'application/javascript',
      sizeBytes: 100,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a declared size over MAX_FILE_SIZE_BYTES', () => {
    const result = fileMetaSchema.safeParse({
      filename: 'big.png',
      mimeType: 'image/png',
      sizeBytes: MAX_FILE_SIZE_BYTES + 1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty filename', () => {
    const result = fileMetaSchema.safeParse({
      filename: '',
      mimeType: 'image/png',
      sizeBytes: 100,
    })
    expect(result.success).toBe(false)
  })

  // A bare `.parse()` would throw an uncaught ZodError for every case
  // above, which the POST route used to turn into a 500. safeParse()'s
  // result carries an `error` object with the same shape the route wraps
  // into a 400 — asserting `.success === false` here is what pins that
  // conversion point down without booting Nitro to hit the route directly.
  it('never throws — every rejection is a safeParse failure, not an exception', () => {
    expect(() =>
      fileMetaSchema.safeParse({ filename: '', mimeType: 'x', sizeBytes: -1 }),
    ).not.toThrow()
  })
})

describe('dispositionForMimeType', () => {
  it('forces a download for PDFs', () => {
    expect(dispositionForMimeType('application/pdf')).toBe('attachment')
  })

  it('renders every image type inline', () => {
    expect(dispositionForMimeType('image/png')).toBe('inline')
    expect(dispositionForMimeType('image/jpeg')).toBe('inline')
    expect(dispositionForMimeType('image/webp')).toBe('inline')
  })
})

describe('contentDispositionValue', () => {
  it('quotes the ASCII fallback and adds an RFC 5987 UTF-8 form, defaulting to inline', () => {
    const value = contentDispositionValue('report.pdf')
    expect(value).toBe(`inline; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  })

  it('honors an explicit attachment disposition', () => {
    const value = contentDispositionValue('report.pdf', 'attachment')
    expect(value.startsWith('attachment;')).toBe(true)
  })

  it('escapes an embedded double quote rather than letting it close the value early', () => {
    const value = contentDispositionValue('evil".pdf')
    expect(value).toContain(`filename="evil'.pdf"`)
    expect(value).not.toContain('".pdf"; filename*')
  })

  it('never lets a newline reach the header value', () => {
    const value = contentDispositionValue('report.pdf\r\nSet-Cookie: hijacked=1')
    expect(value).not.toMatch(/[\r\n]/)
  })

  it('never throws on a filename truncated mid-surrogate-pair', () => {
    const hostile = 'a' + '😀'.repeat(100)
    const truncated = sanitizeFilename(hostile)
    expect(() => contentDispositionValue(truncated)).not.toThrow()
    expect(contentDispositionValue(truncated)).toContain('filename=')
  })

  it('never throws even on a raw lone surrogate, independent of sanitizeFilename', () => {
    // Defense in depth: this has to be safe on its own, for a row an older
    // build could have already written before sanitizeFilename() was fixed
    // — String.fromCharCode(0xd83d) is a lone UTF-16 high surrogate with no
    // low-surrogate partner, constructed at runtime rather than typed as a
    // literal escape so the source file itself stays valid UTF-8.
    const loneSurrogate = `file-${String.fromCharCode(0xd83d)}-name.png`
    expect(() => contentDispositionValue(loneSurrogate)).not.toThrow()
    const value = contentDispositionValue(loneSurrogate)
    expect(value).toContain('filename=')
  })
})

describe('createFileRecord / markUploaded', () => {
  it('inserts a pending row and flips it to uploaded', async () => {
    const created = await createFileRecord(db, {
      userId: USER,
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      r2Key: buildR2Key(USER, 'image/png'),
    })
    expect(created.status).toBe('pending')

    const uploaded = await markUploaded(db, created.id, USER)
    expect(uploaded?.status).toBe('uploaded')
    expect(uploaded?.id).toBe(created.id)
  })

  it('does not flip a row belonging to a different user', async () => {
    const created = await createFileRecord(db, {
      userId: USER,
      filename: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      r2Key: buildR2Key(USER, 'image/png'),
    })

    const result = await markUploaded(db, created.id, OTHER)
    expect(result).toBeNull()

    const stillPending = await getFileById(db, created.id, USER)
    expect(stillPending?.status).toBe('pending')
  })
})

describe('listFiles', () => {
  it("returns only the caller's own files, newest first", async () => {
    const now = Date.now()

    const first = await createFileRecord(db, newFileInput(USER, 'a.pdf'))
    await backdate(first.id, new Date(now - 3000))

    const second = await createFileRecord(db, newFileInput(USER, 'b.pdf'))
    await backdate(second.id, new Date(now - 1000))

    const theirs = await createFileRecord(db, newFileInput(OTHER, 'secret.pdf'))
    await backdate(theirs.id, new Date(now - 500))

    const rows = await listFiles(db, USER)
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id])
    expect(rows.some((row) => row.id === theirs.id)).toBe(false)
  })

  it('respects limit and paginates by cursor', async () => {
    const now = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await createFileRecord(db, newFileInput(USER, `f${i}.pdf`))
      await backdate(row.id, new Date(now - i * 1000))
      ids.push(row.id)
    }
    // ids[0] is newest (smallest offset), ids[4] is oldest.

    const firstPage = await listFiles(db, USER, { limit: 2 })
    expect(firstPage.map((r) => r.id)).toEqual([ids[0], ids[1]])

    const cursor = { createdAt: firstPage[1]!.createdAt, id: firstPage[1]!.id }
    const secondPage = await listFiles(db, USER, { limit: 2, cursor })
    expect(secondPage.map((r) => r.id)).toEqual([ids[2], ids[3]])
  })

  it('does not skip a row that shares a second with the cursor row', async () => {
    // D1 timestamps are epoch SECONDS — three rows backdated to the exact
    // same instant are indistinguishable by created_at alone. A cursor
    // keyed only on created_at (the bug this replaced) would drop whichever
    // tied row wasn't the cursor row; keying on (created_at, id) must not.
    const tiedInstant = new Date(Math.floor(Date.now() / 1000) * 1000)
    const a = await createFileRecord(db, newFileInput(USER, 'a.pdf'))
    const b = await createFileRecord(db, newFileInput(USER, 'b.pdf'))
    const c = await createFileRecord(db, newFileInput(USER, 'c.pdf'))
    await backdate(a.id, tiedInstant)
    await backdate(b.id, tiedInstant)
    await backdate(c.id, tiedInstant)

    const firstPage = await listFiles(db, USER, { limit: 1 })
    expect(firstPage).toHaveLength(1)

    const cursor = { createdAt: firstPage[0]!.createdAt, id: firstPage[0]!.id }
    const restPages = await listFiles(db, USER, { limit: 10, cursor })

    // Together, the two calls must cover all three rows exactly once.
    const seenIds = [...firstPage, ...restPages].map((r) => r.id)
    expect(new Set(seenIds).size).toBe(3)
    expect(restPages.some((r) => r.id === firstPage[0]!.id)).toBe(false)
  })

  it('does not restart the list when the cursor row has since been deleted', async () => {
    const now = Date.now()
    const rows: { id: string }[] = []
    for (let i = 0; i < 4; i++) {
      const row = await createFileRecord(db, newFileInput(USER, `f${i}.pdf`))
      await backdate(row.id, new Date(now - i * 1000))
      rows.push(row)
    }

    const firstPage = await listFiles(db, USER, { limit: 2 })
    expect(firstPage.map((r) => r.id)).toEqual([rows[0]!.id, rows[1]!.id])

    const cursor = { createdAt: firstPage[1]!.createdAt, id: firstPage[1]!.id }

    // The old lookup-based cursor resolved `id` against the table to find
    // its createdAt; deleting the row it names made that lookup fail and
    // silently dropped the filter, restarting the list at page 1. The
    // current cursor carries its own position, so this has no lookup to fail.
    await deleteFileRecord(db, firstPage[1]!.id, USER)

    const secondPage = await listFiles(db, USER, { limit: 2, cursor })
    expect(secondPage.map((r) => r.id)).toEqual([rows[2]!.id, rows[3]!.id])
  })

  it("ignores a cursor naming another user's createdAt/id — the query is scoped, not the cursor", async () => {
    const mine = await createFileRecord(db, newFileInput(USER, 'mine.pdf'))
    const theirs = await createFileRecord(db, newFileInput(OTHER, 'theirs.pdf'))

    const cursor = { createdAt: theirs.createdAt, id: theirs.id }
    const rows = await listFiles(db, USER, { cursor })
    // Whatever the filter does with someone else's position, the userId
    // scope in the WHERE clause is unconditional — no row of OTHER's can
    // ever appear in USER's list.
    expect(rows.some((r) => r.id === theirs.id)).toBe(false)
    expect(rows.some((r) => r.id === mine.id) || rows.length === 0).toBe(true)
  })
})

describe('encodeFilesCursor / decodeFilesCursor', () => {
  it('round-trips a cursor exactly, at second precision', () => {
    const createdAt = new Date(Math.floor(1700000000123 / 1000) * 1000)
    const token = encodeFilesCursor({ createdAt, id: 'abc-123' })
    const decoded = decodeFilesCursor(token)
    expect(decoded).not.toBeNull()
    expect(decoded?.id).toBe('abc-123')
    expect(decoded?.createdAt.getTime()).toBe(createdAt.getTime())
  })

  it('rejects malformed base64', () => {
    expect(decodeFilesCursor('not-valid-base64!!!')).toBeNull()
  })

  it('rejects base64 that decodes to non-JSON', () => {
    expect(decodeFilesCursor(btoa('not json at all'))).toBeNull()
  })

  it('rejects JSON of the wrong shape', () => {
    expect(decodeFilesCursor(btoa(JSON.stringify({ wrong: 'shape' })))).toBeNull()
    expect(decodeFilesCursor(btoa(JSON.stringify({ t: 'not-a-number', id: 'x' })))).toBeNull()
    expect(decodeFilesCursor(btoa(JSON.stringify({ t: 1700000000, id: '' })))).toBeNull()
  })

  it('rejects a hand-tampered real token', () => {
    const token = encodeFilesCursor({ createdAt: new Date(), id: 'abc-123' })
    // Flip the last two characters — overwhelmingly likely to break base64
    // decoding, JSON parsing, or the schema, and decodeFilesCursor()
    // collapses all three failure modes to the same null.
    const tampered = `${token.slice(0, -2)}${token.at(-1) === 'A' ? 'B' : 'A'}A`
    expect(decodeFilesCursor(tampered)).toBeNull()
  })
})

describe('getFileById', () => {
  it("returns null for another user's file, identically to a missing id", async () => {
    const theirs = await createFileRecord(db, newFileInput(OTHER, 'secret.pdf'))

    expect(await getFileById(db, theirs.id, USER)).toBeNull()
    expect(await getFileById(db, 'not-a-real-id', USER)).toBeNull()
    expect(await getFileById(db, theirs.id, OTHER)).not.toBeNull()
  })

  it('never returns userId', async () => {
    const row = await createFileRecord(db, newFileInput(USER, 'mine.pdf'))
    const found = (await getFileById(db, row.id, USER)) as Record<string, unknown> | null
    expect(found?.userId).toBeUndefined()
    // r2Key IS still there — the single-file routes need it for blob.serve()/blob.del().
    expect(found?.r2Key).toBe(row.r2Key)
  })
})

describe('deleteFileRecord', () => {
  it('deletes only when the caller owns the row', async () => {
    const mine = await createFileRecord(db, newFileInput(USER, 'mine.pdf'))

    const wrongOwner = await deleteFileRecord(db, mine.id, OTHER)
    expect(wrongOwner).toBeNull()
    expect(await getFileById(db, mine.id, USER)).not.toBeNull()

    const deleted = await deleteFileRecord(db, mine.id, USER)
    expect(deleted?.id).toBe(mine.id)
    expect(await getFileById(db, mine.id, USER)).toBeNull()
  })
})

describe('countFilesForUser / isFilesQuotaExceeded', () => {
  it('counts pending and uploaded rows together, scoped to one user', async () => {
    expect(await countFilesForUser(db, USER)).toBe(0)

    const a = await createFileRecord(db, newFileInput(USER, 'a.pdf'))
    expect(await countFilesForUser(db, USER)).toBe(1)

    await markUploaded(db, a.id, USER)
    expect(await countFilesForUser(db, USER)).toBe(1) // a status change isn't a new row

    await createFileRecord(db, newFileInput(USER, 'b.pdf'))
    expect(await countFilesForUser(db, USER)).toBe(2)

    await createFileRecord(db, newFileInput(OTHER, 'theirs.pdf'))
    expect(await countFilesForUser(db, USER)).toBe(2) // unaffected by another user's rows
  })

  it('reports exceeded only at or above MAX_FILES_PER_USER', async () => {
    // Bulk-inserted directly (bypassing createFileRecord's one-row-per-call
    // overhead for what would otherwise be MAX_FILES_PER_USER round trips) —
    // the row shape matches what createFileRecord() itself writes. Chunked
    // at 10 rows (90 bound params, 9 columns each) per statement: D1's
    // bound-parameter cap is well below what one insert of
    // MAX_FILES_PER_USER rows would need.
    const seedRows = Array.from({ length: MAX_FILES_PER_USER - 1 }, (_, i) => ({
      userId: USER,
      filename: `bulk-${i}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: `uploads/${USER}/bulk-${i}.pdf`,
      status: 'uploaded' as const,
    }))
    const CHUNK_SIZE = 10
    for (let i = 0; i < seedRows.length; i += CHUNK_SIZE) {
      await db.insert(schema.files).values(seedRows.slice(i, i + CHUNK_SIZE))
    }

    expect(await countFilesForUser(db, USER)).toBe(MAX_FILES_PER_USER - 1)
    expect(await isFilesQuotaExceeded(db, USER)).toBe(false)

    await createFileRecord(db, newFileInput(USER, 'last.pdf'))
    expect(await countFilesForUser(db, USER)).toBe(MAX_FILES_PER_USER)
    expect(await isFilesQuotaExceeded(db, USER)).toBe(true)
  })
})

describe('toFileView', () => {
  it('never exposes r2Key or userId', async () => {
    const row = await createFileRecord(db, newFileInput(USER, 'mine.pdf'))

    const view = toFileView(row) as Record<string, unknown>
    expect(view.r2Key).toBeUndefined()
    expect(view.userId).toBeUndefined()
    expect(view.id).toBe(row.id)
    expect(typeof view.createdAt).toBe('string')
  })
})

describe('shared upload limits', () => {
  it('keeps MAX_FILE_SIZE_BYTES and MAX_FILE_SIZE_LABEL in agreement', () => {
    const match = MAX_FILE_SIZE_LABEL.match(/^(\d+)(B|KB|MB|GB)$/)
    expect(match).not.toBeNull()
    const [, amount, unit] = match!
    const multiplier = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }[
      unit as 'B' | 'KB' | 'MB' | 'GB'
    ]
    expect(Number(amount) * multiplier).toBe(MAX_FILE_SIZE_BYTES)
  })

  it('gives every allowed type a mapped extension', () => {
    for (const mimeType of ALLOWED_FILE_TYPES) {
      expect(FILE_TYPE_EXTENSIONS[mimeType]).toBeTruthy()
    }
  })
})
