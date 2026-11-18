// deliverPush against a real D1 and a push service that answers what the test
// tells it to. What it sent is decrypted with the browser's own key, so "sent"
// means a browser could have read it.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { generateVapidKeys } from '../server/utils/push-crypto'
import { deliverPush, PUSH_TTL_SECONDS } from '../server/utils/push-send'
import type { PushKeys } from '../server/utils/push-send'
import { savePushSubscription } from '../server/utils/push-subscriptions'
import { decryptPushPayload, generateBrowserKeys } from './lib/push-receiver'
import type { BrowserKeys } from './lib/push-receiver'

const db = drizzle(env.DB, { schema })
const USER = 'user-push'
const NOW = new Date('2026-11-18T12:00:00Z')
const MESSAGE = { title: 'Your plan changed', body: 'Coach moved Thursday.', url: '/training' }

const vapidKeys = async (): Promise<PushKeys> => ({
  ...(await generateVapidKeys()),
  subject: 'https://app.example',
})

interface Sent {
  url: string
  headers: Record<string, string>
  body: Uint8Array
}

/** A push service: records each request and answers with the status set for its URL. */
function pushService(statuses: Record<string, number | Error> = {}) {
  const sent: Sent[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({
      url,
      headers: init!.headers as Record<string, string>,
      body: init!.body as Uint8Array,
    })
    const answer = statuses[url] ?? 201
    if (answer instanceof Error) throw answer
    return new Response(null, { status: answer })
  }) as typeof globalThis.fetch
  return { sent, fetch }
}

async function subscribe(userId: string, endpoint: string): Promise<BrowserKeys> {
  const browser = await generateBrowserKeys()
  await savePushSubscription(db, userId, {
    endpoint,
    keys: { p256dh: browser.p256dh, auth: browser.auth },
  })
  return browser
}

const rows = () => db.select().from(schema.pushSubscriptions)
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone'
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/laptop'
const IPAD = 'https://web.push.apple.com/ipad'

let keys: PushKeys

beforeEach(async () => {
  await db.delete(schema.pushSubscriptions)
  keys = await vapidKeys()
})

describe('deliverPush', () => {
  it('sends every one of the person’s browsers a message it can read', async () => {
    const phone = await subscribe(USER, PHONE)
    const laptop = await subscribe(USER, LAPTOP)
    await subscribe('someone-else', IPAD)
    const service = pushService()

    const result = await deliverPush(
      { db, keys, fetch: service.fetch, now: () => NOW },
      USER,
      MESSAGE,
    )

    expect(result).toEqual({ sent: 2, removed: 0, failed: 0 })
    expect(service.sent.map((request) => request.url).sort()).toEqual([PHONE, LAPTOP].sort())
    for (const [browser, url] of [
      [phone, PHONE],
      [laptop, LAPTOP],
    ] as const) {
      const request = service.sent.find((entry) => entry.url === url)!
      expect(JSON.parse(await decryptPushPayload(browser, request.body))).toEqual(MESSAGE)
      expect(request.headers).toMatchObject({
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
      })
      expect(request.headers.Authorization).toMatch(
        new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`),
      )
    }
  })

  it('signs one token per push service, for that service', async () => {
    await subscribe(USER, PHONE)
    await subscribe(USER, 'https://fcm.googleapis.com/fcm/send/tablet')
    await subscribe(USER, LAPTOP)
    const service = pushService()

    await deliverPush({ db, keys, fetch: service.fetch, now: () => NOW }, USER, MESSAGE)

    const audience = (request: Sent) => {
      const claims = request.headers.Authorization!.split('.')[1]!
      return JSON.parse(atob(claims.replace(/-/g, '+').replace(/_/g, '/'))).aud as string
    }
    const byOrigin = new Map<string, Set<string>>()
    for (const request of service.sent) {
      expect(audience(request)).toBe(new URL(request.url).origin)
      const origin = new URL(request.url).origin
      byOrigin.set(origin, (byOrigin.get(origin) ?? new Set()).add(request.headers.Authorization!))
    }
    expect(byOrigin.get('https://fcm.googleapis.com')!.size).toBe(1)
    expect(byOrigin.size).toBe(2)
  })

  it('records when the push service last accepted a message', async () => {
    await subscribe(USER, PHONE)
    await deliverPush({ db, keys, fetch: pushService().fetch, now: () => NOW }, USER, MESSAGE)
    expect((await rows())[0]?.lastSuccessAt).toEqual(NOW)
  })

  it.each([404, 410])('deletes a subscription the push service answers %i for', async (status) => {
    await subscribe(USER, PHONE)
    await subscribe(USER, LAPTOP)
    const service = pushService({ [PHONE]: status })

    const result = await deliverPush({ db, keys, fetch: service.fetch }, USER, MESSAGE)

    expect(result).toEqual({ sent: 1, removed: 1, failed: 0 })
    expect((await rows()).map((row) => row.endpoint)).toEqual([LAPTOP])
  })

  it.each([400, 403, 413, 429, 500])(
    'keeps a subscription the push service answers %i for',
    async (status) => {
      await subscribe(USER, PHONE)
      const result = await deliverPush(
        { db, keys, fetch: pushService({ [PHONE]: status }).fetch },
        USER,
        MESSAGE,
      )
      expect(result).toEqual({ sent: 0, removed: 0, failed: 1 })
      const [row] = await rows()
      expect(row?.endpoint).toBe(PHONE)
      expect(row?.lastSuccessAt).toBeNull()
    },
  )

  it('carries on when one push service cannot be reached', async () => {
    await subscribe(USER, PHONE)
    await subscribe(USER, LAPTOP)
    const service = pushService({ [PHONE]: new TypeError('network') })

    const result = await deliverPush({ db, keys, fetch: service.fetch }, USER, MESSAGE)

    expect(result).toEqual({ sent: 1, removed: 0, failed: 1 })
    expect(await rows()).toHaveLength(2)
  })

  it('counts a subscription whose stored keys are unusable as failed, without throwing', async () => {
    await subscribe(USER, PHONE)
    await db
      .update(schema.pushSubscriptions)
      .set({ p256dh: 'not-a-key' })
      .where(eq(schema.pushSubscriptions.endpoint, PHONE))
    const service = pushService()

    const result = await deliverPush({ db, keys, fetch: service.fetch }, USER, MESSAGE)

    expect(result).toEqual({ sent: 0, removed: 0, failed: 1 })
    expect(service.sent).toHaveLength(0)
  })

  it('does nothing without VAPID keys', async () => {
    await subscribe(USER, PHONE)
    const service = pushService()
    const result = await deliverPush({ db, keys: null, fetch: service.fetch }, USER, MESSAGE)
    expect(result).toEqual({ sent: 0, removed: 0, failed: 0 })
    expect(service.sent).toHaveLength(0)
  })

  it('does nothing for a person with no subscription', async () => {
    const service = pushService()
    const result = await deliverPush({ db, keys, fetch: service.fetch }, USER, MESSAGE)
    expect(result).toEqual({ sent: 0, removed: 0, failed: 0 })
    expect(service.sent).toHaveLength(0)
  })

  it('clips a long title and body so the message always fits', async () => {
    const browser = await subscribe(USER, PHONE)
    const service = pushService()

    const result = await deliverPush({ db, keys, fetch: service.fetch }, USER, {
      title: '字'.repeat(500),
      body: '😀'.repeat(2000),
      url: '/training',
    })

    expect(result.sent).toBe(1)
    expect(service.sent[0]!.body.length).toBeLessThanOrEqual(4096)
    const shown = JSON.parse(await decryptPushPayload(browser, service.sent[0]!.body))
    expect([...shown.title]).toHaveLength(100)
    expect([...shown.body]).toHaveLength(300)
    expect(shown.body.endsWith('😀')).toBe(true)
  })
})
