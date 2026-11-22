// Weekly signup cohorts for /api/fleet: calendar weeks, cohort-based steps.

import { env } from 'cloudflare:test'
import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { clearExtensionsForTest, registerFunnelStageContributor } from '../server/utils/extensions'
import { COHORT_WEEKS, collectFleetWeeks, weekStartUtc } from '../server/utils/fleet-cohorts'

const db = drizzle(env.DB, { schema })

// A Wednesday. Its week began Monday 2026-09-21.
const NOW = new Date('2026-09-23T15:00:00.000Z')

function user(id: string, createdAt: string) {
  const at = new Date(createdAt)
  return { id, email: `${id}@example.com`, name: id, createdAt: at, updatedAt: at }
}

const activated = (id: string) => ({
  actorType: 'user',
  action: 'onboarding.activated',
  targetType: 'user',
  actorUserId: id,
  targetId: id,
})

describe('weekStartUtc', () => {
  it('is the Monday at midnight UTC, including for a Sunday and a Monday', () => {
    expect(weekStartUtc(NOW).toISOString()).toBe('2026-09-21T00:00:00.000Z')
    expect(weekStartUtc(new Date('2026-09-27T23:59:59.000Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    )
    expect(weekStartUtc(new Date('2026-09-21T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    )
  })
})

describe('collectFleetWeeks', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_log')
    await env.DB.exec('DELETE FROM users')
  })
  afterEach(() => clearExtensionsForTest())

  it('is eight zeroed weeks, oldest first, on an empty database', async () => {
    const weeks = await collectFleetWeeks(db, NOW)
    expect(weeks).toHaveLength(COHORT_WEEKS)
    expect(weeks.map((week) => week.weekStart)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ])
    for (const week of weeks) {
      expect(week).toMatchObject({ signups: 0, activated: 0, paid: 0 })
    }
  })

  it('files each user under the week they signed up in', async () => {
    await db.insert(schema.users).values([
      // The first second of the window and the last second before it.
      user('first', '2026-08-03T00:00:00.000Z'),
      user('before', '2026-08-02T23:59:59.000Z'),
      // Either side of a Monday midnight.
      user('sun', '2026-09-13T23:59:59.000Z'),
      user('mon', '2026-09-14T00:00:00.000Z'),
      user('tue', '2026-09-15T09:00:00.000Z'),
      user('now', '2026-09-23T10:00:00.000Z'),
    ])
    await db.insert(schema.auditLog).values([
      activated('mon'),
      // The check-then-write race writes two rows; the user counts once.
      activated('mon'),
      activated('sun'),
      // Signed up before the window: not in any week, however recently activated.
      activated('before'),
    ])

    const weeks = await collectFleetWeeks(db, NOW)
    const byStart = Object.fromEntries(weeks.map((week) => [week.weekStart, week]))
    expect(byStart['2026-08-03']).toMatchObject({ signups: 1, activated: 0 })
    expect(byStart['2026-09-07']).toMatchObject({ signups: 1, activated: 1 })
    expect(byStart['2026-09-14']).toMatchObject({ signups: 2, activated: 1 })
    expect(byStart['2026-09-21']).toMatchObject({ signups: 1, activated: 0 })
    expect(weeks.reduce((sum, week) => sum + week.signups, 0)).toBe(5)
  })

  it('asks the paid contributor once per week, with that week as the cohort', async () => {
    await db
      .insert(schema.users)
      .values([
        user('a', '2026-09-15T09:00:00.000Z'),
        user('b', '2026-09-16T09:00:00.000Z'),
        user('c', '2026-09-22T09:00:00.000Z'),
      ])
    const payers = ['a', 'c']
    registerFunnelStageContributor({
      key: 'paid',
      async count(database, cohort) {
        const rows = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.id, cohort))
        return rows.filter((row) => payers.includes(row.id)).length
      },
    })

    const weeks = await collectFleetWeeks(db, NOW)
    expect(weeks.map((week) => week.paid)).toEqual([0, 0, 0, 0, 0, 0, 1, 1])
  })
})
