// The R2 upload feature's db-only half, run against a real D1 inside
// workerd. No R2 binding involved — the blob calls live in
// server/api/files/*.ts, not here (server/utils/files.ts's own header
// explains why) — so what this file pins down is everything that doesn't
// need one:
//
//   1. sanitizeFilename() neutralizes a hostile display name.
//   2. buildR2Key() never accepts a filename at all, so nothing a caller
//      names a file can ever influence the key — the `uploads/<user_id>/`
//      prefix invariant from server/db/schema.ts › `files` holds regardless.
//   3. The row operations are correctly scoped to their owner: one user's
//      list, get, and delete never reach another user's files.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  MAX_FILENAME_LENGTH,
  buildR2Key,
  contentDispositionValue,
  createFileRecord,
  deleteFileRecord,
  getFileById,
  listFiles,
  markUploaded,
  sanitizeFilename,
  toFileView,
} from '../server/utils/files'
import {
  ALLOWED_FILE_TYPES,
  FILE_TYPE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
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

describe('contentDispositionValue', () => {
  it('quotes the ASCII fallback and adds an RFC 5987 UTF-8 form', () => {
    const value = contentDispositionValue('report.pdf')
    expect(value).toBe(`inline; filename="report.pdf"; filename*=UTF-8''report.pdf`)
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

    const first = await createFileRecord(db, {
      userId: USER,
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(USER, 'application/pdf'),
    })
    await backdate(first.id, new Date(now - 3000))

    const second = await createFileRecord(db, {
      userId: USER,
      filename: 'b.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(USER, 'application/pdf'),
    })
    await backdate(second.id, new Date(now - 1000))

    const theirs = await createFileRecord(db, {
      userId: OTHER,
      filename: 'secret.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(OTHER, 'application/pdf'),
    })
    await backdate(theirs.id, new Date(now - 500))

    const rows = await listFiles(db, USER)
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id])
    expect(rows.some((row) => row.id === theirs.id)).toBe(false)
  })

  it('respects limit and paginates by cursor', async () => {
    const now = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await createFileRecord(db, {
        userId: USER,
        filename: `f${i}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        r2Key: buildR2Key(USER, 'application/pdf'),
      })
      await backdate(row.id, new Date(now - i * 1000))
      ids.push(row.id)
    }
    // ids[0] is newest (smallest offset), ids[4] is oldest.

    const firstPage = await listFiles(db, USER, { limit: 2 })
    expect(firstPage.map((r) => r.id)).toEqual([ids[0], ids[1]])

    const secondPage = await listFiles(db, USER, { limit: 2, cursor: firstPage[1]!.id })
    expect(secondPage.map((r) => r.id)).toEqual([ids[2], ids[3]])
  })

  it('ignores a cursor id that belongs to another user', async () => {
    const mine = await createFileRecord(db, {
      userId: USER,
      filename: 'mine.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(USER, 'application/pdf'),
    })
    const theirs = await createFileRecord(db, {
      userId: OTHER,
      filename: 'theirs.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(OTHER, 'application/pdf'),
    })

    // A cursor naming someone else's row id doesn't filter anything out —
    // it just fails to match, same as any other unrecognized cursor.
    const rows = await listFiles(db, USER, { cursor: theirs.id })
    expect(rows.map((r) => r.id)).toEqual([mine.id])
  })
})

describe('getFileById', () => {
  it("returns null for another user's file, identically to a missing id", async () => {
    const theirs = await createFileRecord(db, {
      userId: OTHER,
      filename: 'secret.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(OTHER, 'application/pdf'),
    })

    expect(await getFileById(db, theirs.id, USER)).toBeNull()
    expect(await getFileById(db, 'not-a-real-id', USER)).toBeNull()
    expect(await getFileById(db, theirs.id, OTHER)).not.toBeNull()
  })
})

describe('deleteFileRecord', () => {
  it('deletes only when the caller owns the row', async () => {
    const mine = await createFileRecord(db, {
      userId: USER,
      filename: 'mine.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(USER, 'application/pdf'),
    })

    const wrongOwner = await deleteFileRecord(db, mine.id, OTHER)
    expect(wrongOwner).toBeNull()
    expect(await getFileById(db, mine.id, USER)).not.toBeNull()

    const deleted = await deleteFileRecord(db, mine.id, USER)
    expect(deleted?.id).toBe(mine.id)
    expect(await getFileById(db, mine.id, USER)).toBeNull()
  })
})

describe('toFileView', () => {
  it('never exposes r2Key or userId', async () => {
    const row = await createFileRecord(db, {
      userId: USER,
      filename: 'mine.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      r2Key: buildR2Key(USER, 'application/pdf'),
    })

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
