// The subscription store against a real D1: what it accepts, whose a
// subscription is, and that account deletion and export cover it.

import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount } from '~~/server/utils/account'
import { clearExtensionsForTest, getAccountContributors } from '~~/server/utils/extensions'
import {
  hasPushSubscription,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  pushSubscriptionSchema,
  removePushSubscription,
  savePushSubscription,
} from '../server/utils/push-subscriptions'
import { registerPwaExtensions } from '../server/utils/pwa-extensions'
import { isPushServiceEndpoint } from '../shared/utils/push'
import { generateBrowserKeys } from './lib/push-receiver'

const db = drizzle(env.DB, { schema })
const ADA = 'user-ada'
const GRACE = 'user-grace'
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone'

async function subscription(endpoint: string) {
  const browser = await generateBrowserKeys()
  return { endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth } }
}

const rows = () => db.select().from(schema.pushSubscriptions)

beforeEach(async () => {
  clearExtensionsForTest()
  await db.delete(schema.pushSubscriptions)
  await db.delete(schema.auditLog)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: ADA, email: 'ada@example.com', name: 'Ada' })
})

describe('which endpoints are accepted', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://db5p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
  ])('takes %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evil.example/?https://fcm.googleapis.com',
    'https://notify.windows.com.evil.example/w',
    'https://push.apple.com.evil.example/abc',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://localhost/abc',
    'https://10.0.0.1/abc',
    'not a url',
    '',
  ])('refuses %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false)
  })

  it('validates a whole subscription the way the subscribe route needs', async () => {
    const good = await subscription(PHONE)
    expect(pushSubscriptionSchema.safeParse({ ...good, expirationTime: null }).success).toBe(true)
    expect(
      pushSubscriptionSchema.safeParse({ ...good, endpoint: 'https://evil.example/x' }).success,
    ).toBe(false)
    expect(
      pushSubscriptionSchema.safeParse({ ...good, keys: { ...good.keys, p256dh: 'AAAA' } }).success,
    ).toBe(false)
    expect(
      pushSubscriptionSchema.safeParse({ ...good, keys: { ...good.keys, auth: 'not base64!' } })
        .success,
    ).toBe(false)
    expect(pushSubscriptionSchema.safeParse({ endpoint: PHONE }).success).toBe(false)
  })
})

describe('whose a subscription is', () => {
  it('stores one row per browser, replacing its keys when it subscribes again', async () => {
    await savePushSubscription(db, ADA, await subscription(PHONE))
    const again = await subscription(PHONE)
    await savePushSubscription(db, ADA, again)

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ userId: ADA, endpoint: PHONE, p256dh: again.keys.p256dh })
  })

  it('moves a browser to the account that subscribed in it last', async () => {
    await savePushSubscription(db, ADA, await subscription(PHONE))
    await savePushSubscription(db, GRACE, await subscription(PHONE))

    expect(await hasPushSubscription(db, ADA, PHONE)).toBe(false)
    expect(await hasPushSubscription(db, GRACE, PHONE)).toBe(true)
    expect(await rows()).toHaveLength(1)
  })

  it('removes only the caller’s own subscription', async () => {
    await savePushSubscription(db, ADA, await subscription(PHONE))

    expect(await removePushSubscription(db, GRACE, PHONE)).toBe(false)
    expect(await rows()).toHaveLength(1)
    expect(await removePushSubscription(db, ADA, PHONE)).toBe(true)
    expect(await rows()).toHaveLength(0)
  })

  it('keeps the newest subscriptions once an account is past the cap', async () => {
    const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`
    for (let n = 0; n < MAX_PUSH_SUBSCRIPTIONS_PER_USER; n++) {
      await savePushSubscription(db, ADA, await subscription(endpoint(n)))
      // Timestamps are whole seconds; spread them so "oldest" means something.
      await db
        .update(schema.pushSubscriptions)
        .set({ updatedAt: new Date(Date.UTC(2026, 0, 1 + n)) })
        .where(eq(schema.pushSubscriptions.endpoint, endpoint(n)))
    }
    await savePushSubscription(db, GRACE, await subscription(PHONE))
    await savePushSubscription(db, ADA, await subscription(endpoint(99)))

    const kept = (await rows()).filter((row) => row.userId === ADA).map((row) => row.endpoint)
    expect(kept).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER)
    expect(kept).not.toContain(endpoint(0))
    expect(kept).toContain(endpoint(99))
    expect(await hasPushSubscription(db, GRACE, PHONE)).toBe(true)
  })
})

describe('account deletion and export', () => {
  it('deletes the person’s subscriptions with the account, and counts them on the audit row', async () => {
    registerPwaExtensions()
    await savePushSubscription(db, ADA, await subscription(PHONE))
    await savePushSubscription(db, ADA, await subscription('https://web.push.apple.com/ipad'))
    await savePushSubscription(
      db,
      GRACE,
      await subscription('https://fcm.googleapis.com/fcm/send/hers'),
    )

    expect((await deleteAccount(db, ADA)).outcome).toBe('deleted')

    expect((await rows()).map((row) => row.userId)).toEqual([GRACE])
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(schema.auditLog.targetId, ADA), eq(schema.auditLog.action, 'account.deleted')),
    })
    expect(audit?.metadata).toMatchObject({ pushSubscriptionsCount: 2 })
  })

  it('exports which services hold a subscription, and none of the keys', async () => {
    registerPwaExtensions()
    const saved = await subscription(PHONE)
    await savePushSubscription(db, ADA, saved)

    const contributor = getAccountContributors().find((c) => c.key === 'pushSubscriptions')!
    const section = await contributor.exportSection!(db, ADA)

    expect(section).toEqual([
      { service: 'fcm.googleapis.com', createdAt: expect.any(String), lastSuccessAt: null },
    ])
    const text = JSON.stringify(section)
    expect(text).not.toContain(saved.keys.p256dh)
    expect(text).not.toContain(saved.keys.auth)
    expect(text).not.toContain('/fcm/send/phone')
  })
})
