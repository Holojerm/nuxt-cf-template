// Core with no optional features registered — what a fork that removes
// feedback (or, later, doesn't extend its layer) runs. Each consumer must
// still work and simply omit the feature's section.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { deleteAccount, exportAccount } from '../server/utils/account'
import { listAudit } from '../server/utils/audit'
import { clearExtensionsForTest } from '../server/utils/extensions'
import { registerFeedbackExtensions } from '../server/utils/feedback-extensions'
import { collectFleetCounters } from '../server/utils/fleet-status'
import { computeOnboardingInputs } from '../server/utils/onboarding'

const db = drizzle(env.DB, { schema })
const USER = 'user-ext'

beforeAll(() => clearExtensionsForTest())
afterAll(() => registerFeedbackExtensions())

beforeEach(async () => {
  await db.delete(schema.auditLog)
  await db.delete(schema.feedback)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'ext@example.com', name: 'Ext' })
  // A feedback row exists, but nothing is registered to read it.
  await db.insert(schema.feedback).values({ userId: USER, kind: 'idea', message: 'Hello' })
})

describe('core without feature contributors', () => {
  it('exports without a feedback section', async () => {
    const result = await exportAccount(db, USER)
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('feedback')
  })

  it('deletes, and the audit row carries no feedback count', async () => {
    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })
    const [row] = await listAudit(db, { targetType: 'user', targetId: USER, limit: 1 })
    expect(row?.metadata).not.toHaveProperty('feedbackCount')
  })

  it('reports fleet counters without a feedback group', async () => {
    expect(await collectFleetCounters(db)).not.toHaveProperty('feedback')
  })

  it('computes onboarding inputs without the feedback signal', async () => {
    expect(await computeOnboardingInputs(db, USER)).not.toHaveProperty('hasSentFeedback')
  })

  it('adds every section back once feedback registers', async () => {
    registerFeedbackExtensions()
    expect((await exportAccount(db, USER))?.feedback).toHaveLength(1)
    expect((await collectFleetCounters(db)).feedback).toEqual({ total: 1, open: 1 })
    expect(await computeOnboardingInputs(db, USER)).toMatchObject({ hasSentFeedback: true })
    clearExtensionsForTest()
  })
})
