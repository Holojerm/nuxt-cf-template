// What the product mailed, for /api/fleet: counts per lifecycle step.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { collectFleetEmail, EMAIL_STEP_LIMIT, stepKey } from '../server/utils/fleet-email'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

const send = (userId: string, stepId: string, sentDaysAgo: number, subjectKey = '') => ({
  userId,
  stepId,
  subjectKey,
  sentAt: daysAgo(sentDaysAgo),
})

describe('collectFleetEmail', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM lifecycle_sends')
    await env.DB.exec('DELETE FROM subscriber_sends')
    await env.DB.exec('DELETE FROM announcement_runs')
    await env.DB.exec('DELETE FROM email_subscribers')
    await env.DB.exec('DELETE FROM users')
    await db.insert(schema.users).values(
      ['a', 'b', 'c'].map((id) => ({
        id,
        email: `${id}@example.com`,
        name: id,
        createdAt: daysAgo(60),
        updatedAt: daysAgo(60),
      })),
    )
  })

  it('is zero with no steps on an empty ledger', async () => {
    expect(await collectFleetEmail(db, NOW)).toEqual({
      windowDays: 28,
      sent: 0,
      steps: {},
      capped: 0,
      subscribers: { confirmed: 0, pending: 0 },
    })
  })

  it('counts sends per step inside the window only', async () => {
    await db.insert(schema.lifecycleSends).values([
      send('a', 'activation_nudge', 1),
      send('b', 'activation_nudge', 10),
      send('c', 'activation_nudge', 27),
      send('a', 'pass_expiring', 3, 'ent_1'),
      send('a', 'pass_expiring', 5, 'ent_2'),
      // Outside the 28 days.
      send('b', 'pass_expiring', 29, 'ent_3'),
      send('c', 'win_back', 40),
    ])
    const email = await collectFleetEmail(db, NOW)
    expect(email).toMatchObject({
      windowDays: 28,
      sent: 5,
      steps: { activation_nudge: 3, pass_expiring: 2 },
    })
    expect(Object.keys(email.steps)).toHaveLength(2)
    // Counts and step ids: nothing that names a recipient.
    expect(JSON.stringify(email)).not.toContain('example.com')
  })

  it('caps the steps it lists while `sent` still counts every send', async () => {
    const rows = Array.from({ length: EMAIL_STEP_LIMIT + 2 }, (_, index) =>
      send('a', `step_${index}`, 1),
    )
    // Two statements: D1 allows 100 bound values in one.
    await db.insert(schema.lifecycleSends).values(rows.slice(0, 12))
    await db.insert(schema.lifecycleSends).values(rows.slice(12))
    const email = await collectFleetEmail(db, NOW)
    expect(Object.keys(email.steps)).toHaveLength(EMAIL_STEP_LIMIT)
    expect(email.sent).toBe(EMAIL_STEP_LIMIT + 2)
  })
})

describe('collectFleetEmail with announcements and subscribers', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM lifecycle_sends')
    await env.DB.exec('DELETE FROM subscriber_sends')
    await env.DB.exec('DELETE FROM announcement_runs')
    await env.DB.exec('DELETE FROM email_subscribers')
  })

  it('sums an announcement over accounts and subscribers, and reports the cap and the list', async () => {
    await db.insert(schema.lifecycleSends).values([send('a', 'announcement.exports', 2)])
    await db.insert(schema.subscriberSends).values([
      { subscriberId: 's1', stepId: 'announcement.exports', sentAt: daysAgo(2) },
      { subscriberId: 's2', stepId: 'announcement.exports', sentAt: daysAgo(40) },
    ])
    await db.insert(schema.announcementRuns).values([
      { announcementId: 'exports', capped: 3, createdAt: daysAgo(2) },
      { announcementId: 'old', capped: 9, createdAt: daysAgo(60) },
    ])
    await db
      .insert(schema.emailSubscribers)
      .values([
        { email: 'one@example.com', confirmedAt: daysAgo(5) },
        { email: 'two@example.com', confirmedAt: daysAgo(1) },
        { email: 'three@example.com' },
      ])

    const email = await collectFleetEmail(db, NOW)
    expect(email).toEqual({
      windowDays: 28,
      sent: 2,
      steps: { 'announcement.exports': 2 },
      capped: 3,
      subscribers: { confirmed: 2, pending: 1 },
    })
    expect(JSON.stringify(email)).not.toContain('example.com')
  })
})

describe('stepKey', () => {
  it('passes identifiers and buckets anything else', () => {
    expect(stepKey('activation_nudge')).toBe('activation_nudge')
    expect(stepKey('winBack')).toBe('winBack')
    expect(stepKey('ada@example.com')).toBe('other')
    expect(stepKey('a'.repeat(41))).toBe('other')
  })
})
