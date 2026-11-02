// What billing adds to /api/fleet: the `entitlements` counter group and the
// funnel's `paid` stage, against a real D1 inside workerd. Core's funnel and
// counters, with nothing registered, are in test/fleet-funnel.test.ts and
// test/fleet-status.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { clearExtensionsForTest } from '~~/server/utils/extensions'
import { collectFleetFunnel } from '~~/server/utils/fleet-funnel'
import { collectFleetCounters } from '~~/server/utils/fleet-status'
import { registerBillingExtensions } from '../server/utils/billing-extensions'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

function user(id: string, createdDaysAgo: number) {
  const at = daysAgo(createdDaysAgo)
  return { id, email: `${id}@example.com`, name: id, createdAt: at, updatedAt: at }
}

beforeEach(async () => {
  registerBillingExtensions()
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM users')
})

afterEach(() => clearExtensionsForTest())

describe('entitlements fleet counter', () => {
  it('counts rows by status, and only counts', async () => {
    await db.insert(schema.users).values([user('u-new', 2), user('u-old', 30)])
    await db.insert(schema.entitlements).values([
      { userId: 'u-new', paddleSubscriptionId: 'sub_1', status: 'active' },
      { userId: 'u-old', paddleSubscriptionId: 'sub_2', status: 'active' },
      { userId: 'u-old', paddleSubscriptionId: 'txn_3', status: 'canceled' },
    ])
    const counters = await collectFleetCounters(db, NOW)
    expect(counters.entitlements).toEqual({ byStatus: { active: 2, canceled: 1 } })
  })

  it('is an empty group, not an absent one, with billing registered and no rows', async () => {
    expect((await collectFleetCounters(db, NOW)).entitlements).toEqual({ byStatus: {} })
  })

  it('is absent when billing is not registered', async () => {
    clearExtensionsForTest()
    expect(await collectFleetCounters(db, NOW)).not.toHaveProperty('entitlements')
  })
})

describe('funnel paid stage', () => {
  it('counts distinct cohort users who bought something; grants and old signups are not revenue', async () => {
    await db.insert(schema.users).values([user('a', 2), user('b', 5), user('old', 40)])
    await db.insert(schema.entitlements).values([
      { userId: 'a', paddleSubscriptionId: 'txn_1', status: 'active' },
      { userId: 'a', paddleSubscriptionId: 'sub_2', status: 'active' },
      // Access nobody paid for is not revenue.
      { userId: 'b', paddleSubscriptionId: 'comp_3', status: 'active' },
      { userId: 'b', paddleSubscriptionId: 'referral_4', status: 'active' },
      { userId: 'b', paddleSubscriptionId: 'welcome_5', status: 'active' },
      // Outside the 28-day cohort.
      { userId: 'old', paddleSubscriptionId: 'txn_6', status: 'active' },
    ])
    expect(await collectFleetFunnel(db, NOW)).toMatchObject({ signups: 2, paid: 1 })
  })

  it('reads 0 without billing even when entitlement rows exist', async () => {
    await db.insert(schema.users).values([user('a', 2)])
    await db
      .insert(schema.entitlements)
      .values([{ userId: 'a', paddleSubscriptionId: 'txn_1', status: 'active' }])
    clearExtensionsForTest()
    expect(await collectFleetFunnel(db, NOW)).toMatchObject({ signups: 1, paid: 0 })
  })
})
