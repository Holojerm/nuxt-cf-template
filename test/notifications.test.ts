// The reader that decides whether one email actually gets sent, run against a
// real D1 inside workerd — same shape as test/entitlements.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { isNotificationEnabled, setNotificationPreference } from '../server/utils/notifications'

const db = drizzle(env.DB, { schema })
const USER = 'user-1'

async function makeUser(id = USER) {
  await db
    .insert(schema.users)
    .values({ id, email: `${id}@example.com`, name: id })
    .onConflictDoNothing()
}

beforeEach(async () => {
  await db.delete(schema.notificationPreferences)
  await db.delete(schema.users)
  await makeUser()
})

describe('isNotificationEnabled — mandatory classes', () => {
  it('is always true for billing.* regardless of any row', async () => {
    await setNotificationPreference(
      db,
      USER,
      // Cast past the Zod-enforced optional-type restriction other callers
      // get for free — this exercises the reader's own belt-and-suspenders,
      // not the API's.
      'billing.payment_failed' as never,
      false,
    )
    expect(await isNotificationEnabled(db, USER, 'billing.payment_failed')).toBe(true)
  })

  it('is always true for security.*', async () => {
    expect(await isNotificationEnabled(db, USER, 'security.new_sign_in')).toBe(true)
  })

  it('is always true for account.*', async () => {
    expect(await isNotificationEnabled(db, USER, 'account.deletion_confirmed')).toBe(true)
  })

  it('never even queries the table for a mandatory type — a disabled row for a DIFFERENT optional type does not leak in', async () => {
    await setNotificationPreference(db, USER, 'welcome', false)
    expect(await isNotificationEnabled(db, USER, 'billing.purchase')).toBe(true)
  })
})

describe('isNotificationEnabled — optional classes', () => {
  it('defaults to true when no row exists', async () => {
    expect(await isNotificationEnabled(db, USER, 'welcome')).toBe(true)
  })

  it('is false after an explicit opt-out', async () => {
    await setNotificationPreference(db, USER, 'welcome', false)
    expect(await isNotificationEnabled(db, USER, 'welcome')).toBe(false)
  })

  it('is true again after opting back in', async () => {
    await setNotificationPreference(db, USER, 'welcome', false)
    await setNotificationPreference(db, USER, 'welcome', true)
    expect(await isNotificationEnabled(db, USER, 'welcome')).toBe(true)
  })

  it('keeps event types independent', async () => {
    await setNotificationPreference(db, USER, 'welcome', false)
    expect(await isNotificationEnabled(db, USER, 'product_updates')).toBe(true)
  })

  it('keeps users independent', async () => {
    await makeUser('user-2')
    await setNotificationPreference(db, USER, 'welcome', false)
    expect(await isNotificationEnabled(db, 'user-2', 'welcome')).toBe(true)
  })
})

describe('setNotificationPreference — upsert', () => {
  it('is idempotent on the (user, channel, event) unique index', async () => {
    await setNotificationPreference(db, USER, 'welcome', false)
    await setNotificationPreference(db, USER, 'welcome', false)
    await setNotificationPreference(db, USER, 'welcome', true)

    const rows = await db.query.notificationPreferences.findMany({
      where: (row, { eq }) => eq(row.userId, USER),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.enabled).toBe(true)
  })

  it('refuses to write a row for a mandatory event type', async () => {
    await setNotificationPreference(db, USER, 'billing.payment_failed' as never, false)

    const rows = await db.query.notificationPreferences.findMany({
      where: (row, { eq }) => eq(row.userId, USER),
    })
    expect(rows).toHaveLength(0)
  })
})
