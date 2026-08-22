// Token retention, against a real D1 inside workerd.
//
// The task wrapper in server/tasks/ is not tested here and deliberately has
// nothing in it worth testing: Nitro skips scheduled tasks entirely under
// vitest (`isTest` in its task runtime), so a test that drove the task would be
// testing the shim, not the sweep. All the behaviour lives in
// purgeExpiredTokens(), which takes the Drizzle client explicitly for this
// reason — the same split as checkSession() in test/session-guard.test.ts.
//
// What matters about a purge is what it does NOT delete. Most of these cases
// are live rows sitting next to dead ones.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { PURGE_GRACE_SECONDS, purgeExpiredTokens } from '../server/utils/purge'

const db = drizzle(env.DB, { schema })

const NOW = Date.parse('2026-08-22T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const USER = 'user-1'

/** Comfortably outside the 24h grace window. */
const LONG_AGO = new Date(NOW - 5 * DAY)
/** Dead, but inside the grace window — must survive. */
const RECENTLY = new Date(NOW - 1 * HOUR)
/** Still live. */
const SOON = new Date(NOW + 1 * HOUR)

beforeEach(async () => {
  await env.DB.exec('DELETE FROM mcp_connect_codes')
  await env.DB.exec('DELETE FROM magic_link_tokens')
  await env.DB.exec('DELETE FROM users')
  await db
    .insert(schema.users)
    .values({ id: USER, email: 'ada@example.com', name: 'Ada', referralCode: 'ADA22222' })
})

async function addConnectCode(
  id: string,
  expiresAt: Date,
  usedAt: Date | null = null,
): Promise<void> {
  await db
    .insert(schema.mcpConnectCodes)
    .values({ id, userId: USER, codeHash: `hash-${id}`, expiresAt, usedAt })
}

async function addMagicLink(
  id: string,
  expiresAt: Date,
  usedAt: Date | null = null,
): Promise<void> {
  await db
    .insert(schema.magicLinkTokens)
    .values({ id, email: 'ada@example.com', tokenHash: `hash-${id}`, expiresAt, usedAt })
}

async function remainingIds(table: 'mcp_connect_codes' | 'magic_link_tokens'): Promise<string[]> {
  const rows =
    table === 'mcp_connect_codes'
      ? await db.select({ id: schema.mcpConnectCodes.id }).from(schema.mcpConnectCodes)
      : await db.select({ id: schema.magicLinkTokens.id }).from(schema.magicLinkTokens)
  return rows.map((row) => row.id).sort()
}

describe('purgeExpiredTokens — what it deletes', () => {
  it('deletes rows that expired longer ago than the grace window', async () => {
    await addConnectCode('cc-old', LONG_AGO)
    await addMagicLink('ml-old', LONG_AGO)

    const result = await purgeExpiredTokens(db, { now: NOW })

    expect(result.mcpConnectCodes).toBe(1)
    expect(result.magicLinkTokens).toBe(1)
    expect(await remainingIds('mcp_connect_codes')).toEqual([])
    expect(await remainingIds('magic_link_tokens')).toEqual([])
  })

  it('deletes a spent row even when its expiry is still in the future', async () => {
    // The common case by volume: a link redeemed a minute after it was minted
    // is dead for fourteen more minutes of nominal validity.
    await addConnectCode('cc-used', SOON, LONG_AGO)
    await addMagicLink('ml-used', SOON, LONG_AGO)

    const result = await purgeExpiredTokens(db, { now: NOW })

    expect(result.mcpConnectCodes).toBe(1)
    expect(result.magicLinkTokens).toBe(1)
  })
})

describe('purgeExpiredTokens — what it must not delete', () => {
  it('keeps live, unspent rows', async () => {
    await addConnectCode('cc-live', SOON)
    await addMagicLink('ml-live', SOON)

    const result = await purgeExpiredTokens(db, { now: NOW })

    expect(result).toMatchObject({ mcpConnectCodes: 0, magicLinkTokens: 0 })
    expect(await remainingIds('mcp_connect_codes')).toEqual(['cc-live'])
    expect(await remainingIds('magic_link_tokens')).toEqual(['ml-live'])
  })

  it('keeps rows that died inside the grace window', async () => {
    // This is the property the grace window exists for: an hour-old expired
    // token still lets the verify page say "expired" rather than "invalid",
    // and a spent one is still evidence of a replay.
    await addConnectCode('cc-recent', RECENTLY)
    await addMagicLink('ml-recent-expired', RECENTLY)
    await addMagicLink('ml-recent-used', SOON, RECENTLY)

    const result = await purgeExpiredTokens(db, { now: NOW })

    expect(result).toMatchObject({ mcpConnectCodes: 0, magicLinkTokens: 0 })
    expect(await remainingIds('magic_link_tokens')).toEqual([
      'ml-recent-expired',
      'ml-recent-used',
    ])
  })

  it('sweeps only the two credential tables, never the account they point at', async () => {
    await addConnectCode('cc-old', LONG_AGO)
    await purgeExpiredTokens(db, { now: NOW })

    const users = await db.select({ id: schema.users.id }).from(schema.users)
    expect(users).toEqual([{ id: USER }])
  })

  it('reports the cutoff it used, so the log line is self-explaining', async () => {
    const result = await purgeExpiredTokens(db, { now: NOW })
    expect(result.cutoff).toBe(NOW - PURGE_GRACE_SECONDS * 1000)
  })
})

describe('purgeExpiredTokens — bounded work', () => {
  it('deletes at most `limit` rows per table and flags that more remain', async () => {
    for (let i = 0; i < 5; i++) await addMagicLink(`ml-${i}`, LONG_AGO)

    const first = await purgeExpiredTokens(db, { now: NOW, limit: 2 })
    expect(first.magicLinkTokens).toBe(2)
    // The signal a backlog exists — the reason the cron can run again and make
    // progress instead of timing out forever on one enormous DELETE.
    expect(first.truncated).toBe(true)
    expect(await remainingIds('magic_link_tokens')).toHaveLength(3)

    const second = await purgeExpiredTokens(db, { now: NOW, limit: 10 })
    expect(second.magicLinkTokens).toBe(3)
    expect(second.truncated).toBe(false)
    expect(await remainingIds('magic_link_tokens')).toEqual([])
  })

  it('a grace window of zero makes just-dead rows eligible', async () => {
    await addMagicLink('ml-recent', RECENTLY)

    const result = await purgeExpiredTokens(db, { now: NOW, graceSeconds: 0 })

    expect(result.magicLinkTokens).toBe(1)
  })
})
