// The files layer's abandoned-upload sweep, against a real D1 inside workerd.
// What matters is what it does NOT delete: live and recent uploads sit next
// to abandoned ones in most cases.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { purgePendingUploads } from '../server/utils/files-purge'
import type { PurgeBlobStore } from '../server/utils/files-purge'

const db = drizzle(env.DB, { schema })

const NOW = Date.parse('2026-08-22T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const USER = 'user-1'

/** Comfortably outside the 24h grace window. */
const LONG_AGO = new Date(NOW - 5 * DAY)
/** Inside the grace window — must survive. */
const RECENTLY = new Date(NOW - 1 * HOUR)

beforeEach(async () => {
  await env.DB.exec('DELETE FROM files')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ id: USER, email: 'ada@example.com', name: 'Ada' })
})

/** Records the keys handed to blob.del, and can be told to fail. */
function fakeBlob(fail = false): PurgeBlobStore & { deleted: string[] } {
  const deleted: string[] = []
  return {
    deleted,
    async del(keys: string[]) {
      if (fail) throw new Error('R2 unavailable')
      deleted.push(...keys)
    },
  }
}

async function addFile(id: string, status: 'pending' | 'uploaded', createdAt: Date): Promise<void> {
  await db.insert(schema.files).values({
    id,
    userId: USER,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1234,
    r2Key: `users/${USER}/${id}.png`,
    status,
    createdAt,
  })
}

async function remainingFileIds(): Promise<string[]> {
  const rows = await db.select({ id: schema.files.id }).from(schema.files)
  return rows.map((row) => row.id).sort()
}

describe('purgePendingUploads', () => {
  it('deletes the R2 object and the row for an abandoned upload', async () => {
    await addFile('f-abandoned', 'pending', LONG_AGO)
    const blob = fakeBlob()

    const result = await purgePendingUploads(db, blob, { now: NOW })

    expect(result.files).toBe(1)
    expect(blob.deleted).toEqual([`users/${USER}/f-abandoned.png`])
    expect(await remainingFileIds()).toEqual([])
  })

  it('never touches an uploaded file, however old', async () => {
    // The whole risk of this sweeper: `uploaded` rows are the product.
    await addFile('f-real', 'uploaded', LONG_AGO)

    const result = await purgePendingUploads(db, fakeBlob(), { now: NOW })

    expect(result.files).toBe(0)
    expect(await remainingFileIds()).toEqual(['f-real'])
  })

  it('leaves a pending upload that is still inside the grace window', async () => {
    // An upload in flight right now is `pending` and must survive — the grace
    // window is what separates "in progress" from "abandoned".
    await addFile('f-inflight', 'pending', RECENTLY)

    const result = await purgePendingUploads(db, fakeBlob(), { now: NOW })

    expect(result.files).toBe(0)
    expect(await remainingFileIds()).toEqual(['f-inflight'])
  })

  it('keeps the rows when R2 fails, so the next run retries', async () => {
    // Deleting the row first would orphan the object permanently: its key is
    // the only record that it exists.
    await addFile('f-abandoned', 'pending', LONG_AGO)

    const result = await purgePendingUploads(db, fakeBlob(true), { now: NOW })

    expect(result.files).toBe(0)
    expect(await remainingFileIds()).toEqual(['f-abandoned'])
  })

  it('bounds its work and flags that more remain', async () => {
    for (let i = 0; i < 5; i++) await addFile(`f-${i}`, 'pending', LONG_AGO)

    const first = await purgePendingUploads(db, fakeBlob(), { now: NOW, limit: 2 })
    expect(first).toEqual({ files: 2, truncated: true })

    const second = await purgePendingUploads(db, fakeBlob(), { now: NOW, limit: 10 })
    expect(second).toEqual({ files: 3, truncated: false })
    expect(await remainingFileIds()).toEqual([])
  })
})
