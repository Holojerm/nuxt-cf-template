// Lifecycle email: who is due, and that the runner mails each of them once.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import type { SendEmailOptions, SendEmailResult } from '../server/utils/email'
import { runLifecycle, type LifecycleDeps } from '../server/utils/lifecycle'
import { activationNudgeStep, passExpiringStep } from '../server/utils/lifecycle-steps'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T04:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS)

async function addUser(id: string, createdDaysAgo = 30, email = `${id}@example.com`) {
  const at = daysFromNow(-createdDaysAgo)
  await db.insert(schema.users).values({ id, email, name: id, createdAt: at, updatedAt: at })
}

async function activate(userId: string) {
  await db.insert(schema.auditLog).values({
    actorUserId: userId,
    actorType: 'user',
    action: 'onboarding.activated',
    targetType: 'user',
    targetId: userId,
  })
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
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM users')
})

describe('activationNudgeStep.due', () => {
  it('picks signups 1–7 days old that never activated', async () => {
    await addUser('fresh', 0.5)
    await addUser('stuck', 2)
    await addUser('done', 2)
    await activate('done')
    await addUser('stale', 8)

    const due = await activationNudgeStep.due(db, NOW, 100)
    expect(due.map((r) => r.userId)).toEqual(['stuck'])
  })

  it('skips anyone already nudged', async () => {
    await addUser('stuck', 2)
    await db
      .insert(schema.lifecycleSends)
      .values({ userId: 'stuck', stepId: 'activation_nudge', subjectKey: '' })
    expect(await activationNudgeStep.due(db, NOW, 100)).toEqual([])
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
})

describe('runLifecycle', () => {
  it('sends once, even when the step keeps reporting the user as due', async () => {
    await addUser('stuck', 2)
    const { deps, sent } = fakeDeps()
    const step = { ...activationNudgeStep, id: 'always_due', due: activationNudgeStep.due }

    const first = await runLifecycle(db, [step], deps, NOW)
    const second = await runLifecycle(db, [step], deps, NOW)
    expect(first.always_due).toMatchObject({ due: 1, sent: 1 })
    expect(second.always_due).toMatchObject({ due: 1, alreadySent: 1, sent: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.unsubscribe?.eventType).toBe('tips')
  })

  it('respects an opt-out and never mails a deleted account', async () => {
    await addUser('optout', 2)
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: 'optout', eventType: 'tips', enabled: false })
    await addUser('gone', 2, 'deleted-gone@deleted.invalid')
    const { deps, sent } = fakeDeps()

    const reports = await runLifecycle(db, [activationNudgeStep], deps, NOW)
    expect(reports.activation_nudge).toMatchObject({ due: 2, optedOut: 2, sent: 0 })
    expect(sent).toEqual([])
  })

  it('gives the claim back on a transient failure and keeps it on a rejection', async () => {
    await addUser('stuck', 2)
    const transient = fakeDeps({ sent: false, reason: 'error' })
    await runLifecycle(db, [activationNudgeStep], transient.deps, NOW)
    expect(await db.select().from(schema.lifecycleSends)).toEqual([])

    const rejected = fakeDeps({ sent: false, reason: 'rejected' })
    await runLifecycle(db, [activationNudgeStep], rejected.deps, NOW)
    expect(await db.select().from(schema.lifecycleSends)).toHaveLength(1)
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

  it('keeps going when one step’s query throws', async () => {
    await addUser('stuck', 2)
    const broken = {
      ...activationNudgeStep,
      id: 'broken',
      due: async () => {
        throw new Error('bad sql')
      },
    }
    const { deps, sent } = fakeDeps()
    const reports = await runLifecycle(db, [broken, activationNudgeStep], deps, NOW)
    expect(reports.broken?.due).toBe(0)
    expect(sent).toHaveLength(1)
  })
})
