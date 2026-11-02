// What the feedback layer contributes to core once registered: deletion
// scrubs and counts its rows, export and the admin view gain a `feedback`
// section, fleet counters a `feedback` group, onboarding the hasSentFeedback
// signal. test/extensions.test.ts covers core with nothing registered.

import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount, exportAccount } from '~~/server/utils/account'
import { clearExtensionsForTest, getAdminUserContributors } from '~~/server/utils/extensions'
import { collectFleetCounters } from '~~/server/utils/fleet-status'
import { computeOnboardingInputs } from '~~/server/utils/onboarding'
import { registerFeedbackExtensions } from '../server/utils/feedback-extensions'

const db = drizzle(env.DB, { schema })
const USER = 'user-fb'

beforeAll(() => {
  clearExtensionsForTest()
  registerFeedbackExtensions()
})

beforeEach(async () => {
  await db.delete(schema.auditLog)
  await db.delete(schema.feedback)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'ada@example.com', name: 'Ada' })
})

describe('account deletion', () => {
  it('scrubs PII off a feedback row but keeps the message itself', async () => {
    await db.insert(schema.feedback).values({
      id: 'fb-1',
      userId: USER,
      kind: 'bug',
      message: 'The export button did nothing on Safari',
      email: 'ada@example.com',
      userAgent: 'Mozilla/5.0',
      ipHash: 'abc123',
      posthogDistinctId: 'ph-123',
      replayUrl: 'https://us.posthog.com/replay/abc',
    })

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    const row = await db.query.feedback.findFirst({ where: eq(schema.feedback.id, 'fb-1') })
    expect(row?.message).toBe('The export button did nothing on Safari')
    expect(row?.email).toBeNull()
    expect(row?.userAgent).toBeNull()
    expect(row?.ipHash).toBeNull()
    expect(row?.posthogDistinctId).toBeNull()
    expect(row?.replayUrl).toBeNull()
    // Never a foreign key — left pointing at the now-anonymized account rather
    // than nulled, so "how many people gave feedback" survives.
    expect(row?.userId).toBe(USER)
  })

  it('records the feedback row count on the account.deleted audit row', async () => {
    await db.insert(schema.feedback).values([
      { userId: USER, message: 'one' },
      { userId: USER, message: 'two' },
    ])
    await deleteAccount(db, USER)
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(schema.auditLog.targetId, USER), eq(schema.auditLog.action, 'account.deleted')),
    })
    expect(audit?.metadata).toMatchObject({ feedbackCount: 2 })
  })

  it('honours the per-app options: detach user_id, keep an older count key', async () => {
    clearExtensionsForTest()
    registerFeedbackExtensions({ anonymiseUserId: true, deletionCountKey: 'feedbackAnonymised' })
    try {
      await db.insert(schema.feedback).values({ id: 'fb-1', userId: USER, message: 'one' })
      await deleteAccount(db, USER)
      const row = await db.query.feedback.findFirst({ where: eq(schema.feedback.id, 'fb-1') })
      expect(row?.userId).toBeNull()
      const audit = await db.query.auditLog.findFirst({
        where: and(
          eq(schema.auditLog.targetId, USER),
          eq(schema.auditLog.action, 'account.deleted'),
        ),
      })
      expect(audit?.metadata).toMatchObject({ feedbackAnonymised: 1 })
      expect(audit?.metadata).not.toHaveProperty('feedbackCount')
    } finally {
      clearExtensionsForTest()
      registerFeedbackExtensions()
    }
  })
})

describe('account export', () => {
  it('adds a feedback section that never leaks more than it says', async () => {
    await db.insert(schema.feedback).values({
      id: 'fb-1',
      userId: USER,
      kind: 'idea',
      message: 'Add dark mode',
      status: 'new',
      email: 'ada@example.com',
      repliedBy: 'admin-1',
    })
    const result = await exportAccount(db, USER)
    expect(result?.feedback).toHaveLength(1)
    expect(result?.feedback?.[0]).toMatchObject({ id: 'fb-1', message: 'Add dark mode' })
    expect(result?.feedback?.[0]).not.toHaveProperty('email')
    expect(result?.feedback?.[0]).not.toHaveProperty('repliedBy')
    expect(result?.feedback?.[0]).not.toHaveProperty('ipHash')
  })
})

describe('admin user view', () => {
  it('loads this customer’s feedback, newest first', async () => {
    await db.insert(schema.feedback).values([
      { id: 'old', userId: USER, message: 'first', createdAt: new Date('2026-01-01') },
      { id: 'new', userId: USER, message: 'second', createdAt: new Date('2026-02-01') },
      { id: 'other', userId: 'someone-else', message: 'not theirs' },
    ])
    const contributor = getAdminUserContributors().find((c) => c.key === 'feedback')
    const rows = await contributor?.load(db, USER)
    expect(rows?.map((row) => row.id)).toEqual(['new', 'old'])
  })
})

describe('fleet counters', () => {
  it('adds a feedback group: total and still-new', async () => {
    await db.insert(schema.feedback).values([
      { message: 'love it', status: 'new' },
      { message: 'broken', status: 'new' },
      { message: 'fixed now', status: 'closed' },
    ])
    expect((await collectFleetCounters(db)).feedback).toEqual({ total: 3, open: 2 })
  })
})

describe('onboarding', () => {
  it('reports hasSentFeedback from any row for this user', async () => {
    expect(await computeOnboardingInputs(db, USER)).toMatchObject({ hasSentFeedback: false })
    await db.insert(schema.feedback).values({ userId: USER, message: 'hi' })
    expect(await computeOnboardingInputs(db, USER)).toMatchObject({ hasSentFeedback: true })
  })
})
