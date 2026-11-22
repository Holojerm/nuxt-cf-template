// Product updates for a visitor with no account: double opt-in, and leaving deletes.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import type { SendEmailOptions, SendEmailResult } from '../server/utils/email'
import { isNotificationEnabled } from '../server/utils/notifications'
import type { RateLimitStore } from '../server/utils/rate-limit'
import {
  buildSubscriberConfirmUrl,
  buildSubscriberUnsubscribeUrl,
  signSubscriberToken,
  verifySubscriberToken,
} from '../server/utils/subscriber-tokens'
import {
  confirmSubscription,
  countSubscribers,
  purgePendingSubscribers,
  removeSubscriber,
  removeSubscriberByEmail,
  requestSubscription,
  SUBSCRIBE_ADDRESS_BUDGET,
  type SubscribeDeps,
} from '../server/utils/subscribers'

const db = drizzle(env.DB, { schema })

const SECRET = 'test-session-password-at-least-32-chars-long'
const NOW = new Date('2026-09-26T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function memoryStore(): RateLimitStore {
  const counts = new Map<string, number>()
  return {
    async hit(bucket, _expiresAt, cost) {
      const next = (counts.get(bucket) ?? 0) + cost
      counts.set(bucket, next)
      return next
    },
  }
}

function fakeDeps(result: SendEmailResult = { sent: true, id: 'x' }) {
  const sent: SendEmailOptions[] = []
  const deps: SubscribeDeps = {
    brand: { appName: 'My App', appUrl: 'https://my-app.example' },
    send: async (opts) => {
      sent.push(opts)
      return result
    },
    confirmUrl: async (id) => `https://my-app.example/updates/confirm#s=${id}`,
    store: memoryStore(),
  }
  return { deps, sent }
}

const rows = () => db.select().from(schema.emailSubscribers)

beforeEach(async () => {
  await env.DB.exec('DELETE FROM email_subscribers')
  await env.DB.exec('DELETE FROM notification_preferences')
  await env.DB.exec('DELETE FROM users')
})

describe('requestSubscription', () => {
  it('stores the address unconfirmed and sends only the confirmation', async () => {
    const { deps, sent } = fakeDeps()
    const outcome = await requestSubscription(db, '  Ada@Example.com ', deps, NOW)

    expect(outcome).toEqual({ state: 'sent' })
    const [row] = await rows()
    expect(row).toMatchObject({ email: 'ada@example.com', confirmedAt: null })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('ada@example.com')
    expect(sent[0]?.text).toContain(`https://my-app.example/updates/confirm#s=${row?.id}`)
    // A confirmation is not bulk mail: nothing to unsubscribe from yet.
    expect(sent[0]?.unsubscribe).toBeUndefined()
    expect(await countSubscribers(db)).toEqual({ confirmed: 0, pending: 1 })
  })

  it('reuses the pending row when asked again, and stops at the address budget', async () => {
    const { deps, sent } = fakeDeps()
    for (let i = 0; i < SUBSCRIBE_ADDRESS_BUDGET.limit; i += 1) {
      expect((await requestSubscription(db, 'ada@example.com', deps, NOW)).state).toBe('sent')
    }
    expect((await requestSubscription(db, 'ADA@example.com', deps, NOW)).state).toBe('over_budget')
    expect(sent).toHaveLength(SUBSCRIBE_ADDRESS_BUDGET.limit)
    expect(await rows()).toHaveLength(1)
  })

  it('sends nothing to an address that is already confirmed', async () => {
    const { deps, sent } = fakeDeps()
    await requestSubscription(db, 'ada@example.com', deps, NOW)
    const [row] = await rows()
    await confirmSubscription(db, row!.id, NOW)

    expect((await requestSubscription(db, 'ada@example.com', deps, NOW)).state).toBe(
      'already_confirmed',
    )
    expect(sent).toHaveLength(1)
  })

  it('refuses a reserved address without storing it', async () => {
    const { deps, sent } = fakeDeps()
    const outcome = await requestSubscription(db, 'deleted-1@deleted.invalid', deps, NOW)
    expect(outcome).toEqual({ state: 'refused' })
    expect(sent).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('tells a refused mailbox apart from mail being down', async () => {
    const rejected = fakeDeps({ sent: false, reason: 'rejected' })
    expect((await requestSubscription(db, 'a@example.com', rejected.deps, NOW)).state).toBe(
      'rejected',
    )
    const down = fakeDeps({ sent: false, reason: 'error' })
    const outcome = await requestSubscription(db, 'b@example.com', down.deps, NOW)
    expect(outcome.state).toBe('unavailable')
  })
})

describe('confirmSubscription', () => {
  it('confirms once and keeps the first confirmation time', async () => {
    const { deps } = fakeDeps()
    await requestSubscription(db, 'ada@example.com', deps, NOW)
    const [row] = await rows()

    expect(await confirmSubscription(db, row!.id, NOW)).toBe('confirmed')
    expect(await confirmSubscription(db, row!.id, new Date(NOW.getTime() + DAY_MS))).toBe(
      'confirmed',
    )
    expect((await rows())[0]?.confirmedAt).toEqual(NOW)
    expect(await countSubscribers(db)).toEqual({ confirmed: 1, pending: 0 })
  })

  it('reports a row that no longer exists', async () => {
    expect(await confirmSubscription(db, 'missing', NOW)).toBe('gone')
  })

  it('hands over to the account when the address has one', async () => {
    await db.insert(schema.users).values({ id: 'u1', email: 'ada@example.com', name: 'Ada' })
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: 'u1', eventType: 'product_updates', enabled: false })
    const { deps } = fakeDeps()
    await requestSubscription(db, 'ada@example.com', deps, NOW)
    const [row] = await rows()

    expect(await confirmSubscription(db, row!.id, NOW)).toBe('confirmed')
    expect(await rows()).toEqual([])
    expect(await isNotificationEnabled(db, 'u1', 'product_updates')).toBe(true)
  })
})

describe('leaving', () => {
  it('deletes the address on unsubscribe', async () => {
    const { deps } = fakeDeps()
    await requestSubscription(db, 'ada@example.com', deps, NOW)
    const [row] = await rows()
    await confirmSubscription(db, row!.id, NOW)

    await removeSubscriber(db, row!.id)
    expect(await rows()).toEqual([])
    // A second click on the same link is a no-op, not an error.
    await removeSubscriber(db, row!.id)
  })

  it('removes the row when the same address signs up', async () => {
    const { deps } = fakeDeps()
    await requestSubscription(db, 'ada@example.com', deps, NOW)
    await removeSubscriberByEmail(db, 'Ada@Example.com')
    expect(await rows()).toEqual([])
  })

  it('purges addresses that never confirmed after a week, and only those', async () => {
    const old = new Date(NOW.getTime() - 8 * DAY_MS)
    await db.insert(schema.emailSubscribers).values([
      { email: 'stale@example.com', createdAt: old },
      { email: 'fresh@example.com', createdAt: new Date(NOW.getTime() - DAY_MS) },
      { email: 'kept@example.com', createdAt: old, confirmedAt: old },
    ])
    expect(await purgePendingSubscribers(db, NOW)).toBe(1)
    expect((await rows()).map((row) => row.email).sort()).toEqual([
      'fresh@example.com',
      'kept@example.com',
    ])
  })
})

describe('subscriber tokens', () => {
  it('verify for their own purpose and subscriber only', async () => {
    const token = await signSubscriberToken(SECRET, 'confirm', 'sub-1')
    expect(await verifySubscriberToken(SECRET, 'confirm', 'sub-1', token)).toBe(true)
    expect(await verifySubscriberToken(SECRET, 'leave', 'sub-1', token)).toBe(false)
    expect(await verifySubscriberToken(SECRET, 'confirm', 'sub-2', token)).toBe(false)
    expect(
      await verifySubscriberToken('another-secret-of-sufficient-length', 'confirm', 'sub-1', token),
    ).toBe(false)
    expect(await verifySubscriberToken(SECRET, 'confirm', 'sub-1', 'garbage')).toBe(false)
  })

  it('put the confirmation in a fragment and the unsubscribe in a query', async () => {
    const confirm = await buildSubscriberConfirmUrl(SECRET, 'https://my-app.example/', 'sub-1')
    expect(confirm).toMatch(/^https:\/\/my-app\.example\/updates\/confirm#s=sub-1&t=/)
    const leave = await buildSubscriberUnsubscribeUrl(SECRET, 'https://my-app.example', 'sub-1')
    expect(leave).toMatch(
      /^https:\/\/my-app\.example\/api\/email\/updates\/unsubscribe\?s=sub-1&t=/,
    )
  })
})
