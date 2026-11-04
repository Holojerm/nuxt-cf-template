import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { IDENTITY_SALT_ID, getIdentitySalt, resetIdentitySaltCache } from '../server/utils/identity'

const db = drizzle(env.DB, { schema })

async function rows() {
  return db.select().from(schema.instanceSecrets)
}

beforeEach(async () => {
  resetIdentitySaltCache()
  await env.DB.exec('DELETE FROM instance_secrets')
})

describe('getIdentitySalt', () => {
  it('generates a 32-byte base64url salt on first use and stores it', async () => {
    const salt = await getIdentitySalt(db)
    expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await rows()).toEqual([expect.objectContaining({ id: IDENTITY_SALT_ID, value: salt })])
  })

  it('returns the same salt on every call, from the memo', async () => {
    const first = await getIdentitySalt(db)
    await env.DB.exec('DELETE FROM instance_secrets')
    expect(await getIdentitySalt(db)).toBe(first)
  })

  it('reads an existing row rather than overwriting it', async () => {
    await db.insert(schema.instanceSecrets).values({ id: IDENTITY_SALT_ID, value: 'preexisting' })
    expect(await getIdentitySalt(db)).toBe('preexisting')
    expect((await rows())[0]?.value).toBe('preexisting')
  })

  it('converges concurrent first calls on one stored value', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getIdentitySalt(db)))
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(new Set(results)).toEqual(new Set([stored[0]!.value]))
  })

  it('re-reads the database after the memo is reset', async () => {
    const first = await getIdentitySalt(db)
    resetIdentitySaltCache()
    expect(await getIdentitySalt(db)).toBe(first)
  })
})
