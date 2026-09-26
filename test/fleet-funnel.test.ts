// The /api/fleet funnel: cohort-based, first-party, and safe to store elsewhere.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { collectFleetFunnel, sourceKey } from '../server/utils/fleet-funnel'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

function user(id: string, createdDaysAgo: number, signupSource: string | null = null) {
  const at = daysAgo(createdDaysAgo)
  return { id, email: `${id}@example.com`, name: id, createdAt: at, updatedAt: at, signupSource }
}

describe('collectFleetFunnel', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM entitlements')
    await env.DB.exec('DELETE FROM audit_log')
    await env.DB.exec('DELETE FROM users')
  })

  it('counts each step within the signup cohort only', async () => {
    await db
      .insert(schema.users)
      .values([
        user('a', 2, 'google'),
        user('b', 5, 'Google'),
        user('c', 10, null),
        user('old', 40, 'google'),
      ])
    const activation = { actorType: 'user', action: 'onboarding.activated', targetType: 'user' }
    await db.insert(schema.auditLog).values([
      { ...activation, actorUserId: 'a', targetId: 'a' },
      { ...activation, actorUserId: 'b', targetId: 'b' },
      // A duplicate row (the check-then-write race onboarding.ts accepts) counts once.
      { ...activation, actorUserId: 'b', targetId: 'b' },
      // Outside the cohort: activated, but signed up 40 days ago.
      { ...activation, actorUserId: 'old', targetId: 'old' },
    ])
    await db.insert(schema.entitlements).values([
      { userId: 'a', paddleSubscriptionId: 'txn_1', status: 'active' },
      { userId: 'a', paddleSubscriptionId: 'sub_2', status: 'active' },
      // Access nobody paid for is not revenue.
      { userId: 'b', paddleSubscriptionId: 'comp_3', status: 'active' },
      { userId: 'old', paddleSubscriptionId: 'txn_4', status: 'active' },
    ])

    expect(await collectFleetFunnel(db, NOW)).toEqual({
      cohortDays: 28,
      signups: 3,
      activated: 2,
      paid: 1,
      sources: { google: 2, direct: 1 },
    })
  })
})

describe('sourceKey', () => {
  it('passes short slugs and buckets everything else', () => {
    expect(sourceKey(null)).toBe('direct')
    expect(sourceKey('news.ycombinator.com')).toBe('news.ycombinator.com')
    expect(sourceKey('x')).toBe('x')
    expect(sourceKey('hello world')).toBe('other')
    expect(sourceKey('a'.repeat(41))).toBe('other')
  })
})
