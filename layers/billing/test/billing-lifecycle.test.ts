// Billing's lifecycle email step, `pass_expiring`: who is due, that it is
// mandatory mail, and that billing registers it under that exact id (the id is
// stored in lifecycle_sends; renaming it re-sends to every pass holder).
// Core's runner and its own step are tested in test/lifecycle.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { SendEmailOptions, SendEmailResult } from '~~/server/utils/email'
import { clearExtensionsForTest, getRegisteredLifecycleSteps } from '~~/server/utils/extensions'
import { runLifecycle, type LifecycleDeps } from '~~/server/utils/lifecycle'
import { registerBillingExtensions } from '../server/utils/billing-extensions'
import { passExpiringStep } from '../server/utils/billing-lifecycle'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T04:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS)

async function addUser(id: string, createdDaysAgo = 30, email = `${id}@example.com`) {
  const at = daysFromNow(-createdDaysAgo)
  await db.insert(schema.users).values({ id, email, name: id, createdAt: at, updatedAt: at })
}

async function addEntitlement(userId: string, ref: string, endsInDays: number | null) {
  await db.insert(schema.entitlements).values({
    userId,
    paddleSubscriptionId: ref,
    status: 'active',
    currentPeriodEnd: endsInDays === null ? null : daysFromNow(endsInDays),
  })
}

function fakeDeps(result: SendEmailResult = { sent: true, id: 'x' }) {
  const sent: SendEmailOptions[] = []
  const deps: LifecycleDeps = {
    brand: { appName: 'My App', appUrl: 'https://my-app.example' },
    send: async (opts) => {
      sent.push(opts)
      return result
    },
    unsubscribeUrl: async (userId, type) => `https://my-app.example/u?${userId}&${type}`,
  }
  return { deps, sent }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM lifecycle_sends')
  await env.DB.exec('DELETE FROM notification_preferences')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
})

afterEach(() => clearExtensionsForTest())

describe('lifecycle registration', () => {
  it('adds pass_expiring when billing registers, and not before', () => {
    expect(getRegisteredLifecycleSteps()).toEqual([])
    registerBillingExtensions()
    expect(getRegisteredLifecycleSteps().map((step) => step.id)).toEqual(['pass_expiring'])
    expect(getRegisteredLifecycleSteps()[0]).toBe(passExpiringStep)
    expect(passExpiringStep.notification).toBe('billing.pass_expiring')
  })
})

describe('passExpiringStep.due', () => {
  it('picks a paid pass ending within 3 days that nothing takes over from', async () => {
    await addUser('ending')
    await addEntitlement('ending', 'txn_1', 2)
    await addUser('later')
    await addEntitlement('later', 'txn_2', 5)
    await addUser('renews')
    await addEntitlement('renews', 'txn_3', 2)
    await addEntitlement('renews', 'sub_4', null)
    await addUser('stacked')
    await addEntitlement('stacked', 'txn_5', 2)
    await addEntitlement('stacked', 'txn_6', 32)
    await addUser('comped')
    await addEntitlement('comped', 'comp_7', 2)
    await addUser('lapsed')
    await addEntitlement('lapsed', 'txn_8', -1)

    const due = await passExpiringStep.due(db, NOW, 100)
    expect(due.map((r) => r.userId)).toEqual(['ending'])
    const endsAt = Math.floor(daysFromNow(2).getTime() / 1000)
    expect(due[0]?.subjectKey).toBe(`default:${endsAt}`)
  })

  it('sends mandatory mail with no unsubscribe link, whatever the preferences say', async () => {
    await addUser('ending')
    await addEntitlement('ending', 'txn_1', 2)
    const { deps, sent } = fakeDeps()

    await runLifecycle(db, [passExpiringStep], deps, NOW)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.unsubscribe).toBeUndefined()
    expect(sent[0]?.subject).toContain('access ends')
  })
})
