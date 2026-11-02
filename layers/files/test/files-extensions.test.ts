// What the files layer contributes to core once registered: account deletion
// removes the person's upload rows and R2 objects (best-effort) and counts them
// on the audit row; the purge task gains a `pendingUploads` sweep.
// test/extensions.test.ts covers core with nothing registered.

import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount } from '~~/server/utils/account'
import { clearExtensionsForTest, getPurgeContributors } from '~~/server/utils/extensions'
import { registerFilesExtensions } from '../server/utils/files-extensions'

const db = drizzle(env.DB, { schema })
const USER = 'user-files'

function fakeBlob(fail = false) {
  const deleted: string[] = []
  return {
    deleted,
    async del(keys: string[]) {
      if (fail) throw new Error('R2 unavailable')
      deleted.push(...keys)
    },
  }
}

async function addUpload(id: string): Promise<void> {
  await db.insert(schema.files).values({
    id,
    userId: USER,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 100,
    r2Key: `uploads/${USER}/${id}.png`,
    status: 'uploaded',
  })
}

beforeEach(async () => {
  clearExtensionsForTest()
  await db.delete(schema.auditLog)
  await db.delete(schema.files)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'ada@example.com', name: 'Ada' })
})

describe('account deletion', () => {
  it('removes upload rows and their R2 objects, and counts them on the audit row', async () => {
    const store = fakeBlob()
    registerFilesExtensions(store)
    await addUpload('a')
    await addUpload('b')

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    expect(await db.query.files.findMany({ where: eq(schema.files.userId, USER) })).toHaveLength(0)
    expect(store.deleted.sort()).toEqual([`uploads/${USER}/a.png`, `uploads/${USER}/b.png`])
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(schema.auditLog.targetId, USER), eq(schema.auditLog.action, 'account.deleted')),
    })
    expect(audit?.metadata).toMatchObject({ filesCount: 2 })
  })

  it('still deletes the account when R2 is down', async () => {
    registerFilesExtensions(fakeBlob(true))
    await addUpload('a')

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
    expect(await db.query.files.findMany({ where: eq(schema.files.userId, USER) })).toHaveLength(0)
  })
})

describe('purge', () => {
  it('registers the pendingUploads sweep', () => {
    registerFilesExtensions(fakeBlob())
    expect(getPurgeContributors().map((c) => c.key)).toEqual(['pendingUploads'])
  })
})
