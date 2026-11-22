// Lifecycle email: who is due, and that the runner mails each of them once.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import type { SendEmailOptions, SendEmailResult } from '../server/utils/email'
import { runLifecycle, type LifecycleDeps } from '../server/utils/lifecycle'
import {
  clearExtensionsForTest,
  getRegisteredLifecycleSteps,
  registerLifecycleStep,
} from '../server/utils/extensions'
import { defineLifecycleStep } from '../server/utils/lifecycle-definitions'
import { sendSignupSteps } from '../server/utils/lifecycle-runtime'
import { LIFECYCLE_SEQUENCE } from '../server/utils/lifecycle-sequence'
import { TEMPLATE_LIFECYCLE_STEPS } from '../server/utils/lifecycle-steps'

// Built from the definition, not from the running steps, so a step that is
// switched off (`win_back` ships that way) keeps its query and copy under test.
const stepNamed = (id: string) =>
  defineLifecycleStep(LIFECYCLE_SEQUENCE.find((definition) => definition.id === id)!)
const activationNudgeStep = stepNamed('activation_nudge')
const welcomeStep = stepNamed('welcome')
const winBackStep = stepNamed('win_back')

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T04:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS)

async function addUser(
  id: string,
  createdDaysAgo = 30,
  email = `${id}@example.com`,
  lastLoginDaysAgo?: number,
) {
  const at = daysFromNow(-createdDaysAgo)
  const lastLoginAt = lastLoginDaysAgo === undefined ? null : daysFromNow(-lastLoginDaysAgo)
  await db
    .insert(schema.users)
    .values({ id, email, name: id, createdAt: at, updatedAt: at, lastLoginAt })
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

describe('welcome step', () => {
  it('is due on the first day only, as the daily retry of the sign-up send', async () => {
    await addUser('new', 0.2)
    await addUser('yesterday', 1.5)
    expect((await welcomeStep.due(db, NOW, 100)).map((r) => r.userId)).toEqual(['new'])
  })

  it('goes out at sign-up, once, with its own unsubscribe link', async () => {
    await addUser('new', 0)
    const { deps, sent } = fakeDeps()
    const user = { id: 'new', email: 'new@example.com', name: 'Ada' }

    await sendSignupSteps(db, user, deps)
    await sendSignupSteps(db, user, deps)
    await runLifecycle(db, [welcomeStep], deps, NOW)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).toBe('Welcome to My App')
    expect(sent[0]?.text).toContain('Hi Ada')
    expect(sent[0]?.unsubscribe?.eventType).toBe('welcome')
    const rows = await db.select().from(schema.lifecycleSends)
    expect(rows.map((row) => row.stepId)).toEqual(['welcome'])
  })

  it('is retried by the daily run when the sign-up send failed', async () => {
    await addUser('new', 0.1)
    const down = fakeDeps({ sent: false, reason: 'error' })
    await sendSignupSteps(db, { id: 'new', email: 'new@example.com', name: 'Ada' }, down.deps)
    expect(await db.select().from(schema.lifecycleSends)).toEqual([])

    const { deps, sent } = fakeDeps()
    await runLifecycle(db, [welcomeStep], deps, NOW)
    expect(sent).toHaveLength(1)
  })
})

describe('win-back step', () => {
  it('picks accounts last signed in 45 to 59 days ago, once', async () => {
    await addUser('recent', 200, undefined, 10)
    await addUser('lapsed', 200, undefined, 50)
    await addUser('long_gone', 200, undefined, 90)
    await addUser('never', 200)
    expect((await winBackStep.due(db, NOW, 100)).map((r) => r.userId)).toEqual(['lapsed'])

    const { deps, sent } = fakeDeps()
    await runLifecycle(db, [winBackStep], deps, NOW)
    await runLifecycle(db, [winBackStep], deps, NOW)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.unsubscribe?.eventType).toBe('tips')
    expect(sent[0]?.html).toContain('utm_campaign=win_back')
  })
})

describe('lifecycle step registry', () => {
  afterEach(() => clearExtensionsForTest())

  it('keeps feature steps out of core: the template runs only its own sequence', () => {
    const switchedOn = LIFECYCLE_SEQUENCE.filter((definition) => definition.enabled !== false)
    expect(TEMPLATE_LIFECYCLE_STEPS.map((step) => step.id)).toEqual(
      switchedOn.map((definition) => definition.id),
    )
    expect(getRegisteredLifecycleSteps()).toEqual([])
  })

  it('keeps registered steps in registration order and replaces one registered twice', () => {
    const first = { ...activationNudgeStep, id: 'first' }
    const second = { ...activationNudgeStep, id: 'second' }
    registerLifecycleStep(first)
    registerLifecycleStep(second)
    registerLifecycleStep({ ...first, notification: 'tips' })
    expect(getRegisteredLifecycleSteps().map((step) => step.id)).toEqual(['first', 'second'])
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
