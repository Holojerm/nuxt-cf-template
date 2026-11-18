// The four push routes: what each must do first, read off the route files
// (Vite resolves `?raw` at transform time; workerd has no filesystem), then the
// handlers themselves with the session, the limiter and the config replaced.

import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateBrowserKeys } from './lib/push-receiver'

const SOURCES = import.meta.glob<string>('../server/api/pwa/push/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const ROUTES = Object.entries(SOURCES).map(([file, source]) => ({
  route: file.replace('../server/api/pwa/push/', ''),
  source,
}))

describe('every push route', () => {
  it('is one of the four this file knows about', () => {
    expect(ROUTES.map((entry) => entry.route).sort()).toEqual([
      'key.get.ts',
      'status.post.ts',
      'subscribe.post.ts',
      'unsubscribe.post.ts',
    ])
  })

  it.each(ROUTES)('$route answers 404 without VAPID keys, before doing anything', ({ source }) => {
    const handler = source.slice(source.lastIndexOf('export default defineEventHandler'))
    expect(handler.split('\n')[1]!.trim()).toMatch(/requirePush\(event\)$/)
  })

  it.each(ROUTES)('$route charges the push budget, then requires a session', ({ source }) => {
    const limit = source.indexOf('await rateLimit(event, PUSH_LIMIT)')
    const session = source.indexOf('await requireUserSession(event)')
    expect(limit).toBeGreaterThan(-1)
    expect(session).toBeGreaterThan(limit)
  })

  it('never reads a body in a DELETE: removing a subscription is a POST', () => {
    expect(ROUTES.filter((entry) => entry.route.endsWith('.delete.ts'))).toEqual([])
  })
})

// ── The handlers ─────────────────────────────────────────────────────────────
const calls: string[] = []
let signedInAs: string | null = 'user-ada'
let config = {
  appUrl: 'https://app.example',
  enabled: true,
  publicKey: 'public-key',
  privateKey: 'private-key',
}

vi.mock('@nuxthub/db', async () => {
  const { drizzle } = await import('drizzle-orm/d1')
  const schema = await import('~~/server/db/schema')
  return { db: drizzle(env.DB, { schema }) }
})
vi.mock('#server/utils/rate-limit', () => ({
  rateLimit: async (_event: unknown, limit: { name: string }) => void calls.push(limit.name),
}))

type Handler = (event: { body?: unknown }) => Promise<unknown>
const handlers: Record<string, Handler> = {}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal(
    'readValidatedBody',
    async (event: { body: unknown }, parse: (value: unknown) => unknown) => {
      try {
        return parse(event.body)
      } catch {
        throw Object.assign(new Error('400'), { statusCode: 400 })
      }
    },
  )
  vi.stubGlobal('createError', (input: { statusCode: number }) =>
    Object.assign(new Error(String(input.statusCode)), input),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({
    pwa: { vapidPrivateKey: config.privateKey, vapidSubject: '' },
    public: {
      appUrl: config.appUrl,
      pwa: { enabled: config.enabled, vapidPublicKey: config.publicKey },
    },
  }))
  vi.stubGlobal('requireUserSession', async () => {
    calls.push('session')
    if (!signedInAs) throw Object.assign(new Error('401'), { statusCode: 401 })
    return { user: { id: signedInAs } }
  })
  for (const name of ['key.get', 'status.post', 'subscribe.post', 'unsubscribe.post']) {
    handlers[name] = (await import(`../server/api/pwa/push/${name}.ts`))
      .default as unknown as Handler
  }
})

const PHONE = 'https://fcm.googleapis.com/fcm/send/phone'
const stored = () =>
  env.DB.prepare('SELECT user_id, endpoint FROM push_subscriptions ORDER BY endpoint').all<{
    user_id: string
    endpoint: string
  }>()

async function subscription(endpoint = PHONE) {
  const browser = await generateBrowserKeys()
  return { endpoint, expirationTime: null, keys: { p256dh: browser.p256dh, auth: browser.auth } }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM push_subscriptions')
  calls.length = 0
  signedInAs = 'user-ada'
  config = {
    appUrl: 'https://app.example',
    enabled: true,
    publicKey: 'public-key',
    privateKey: 'private-key',
  }
})

describe('GET /api/pwa/push/key', () => {
  it('hands a signed-in browser the public key, and never the private one', async () => {
    const answer = await handlers['key.get']!({})
    expect(answer).toEqual({ publicKey: 'public-key' })
    expect(JSON.stringify(answer)).not.toContain('private-key')
    expect(calls).toEqual(['pwa-push', 'session'])
  })
})

describe('with push not set up', () => {
  it.each([
    ['no keys', { publicKey: '', privateKey: '' }],
    ['only the public key', { privateKey: '' }],
    ['only the private key', { publicKey: '' }],
    ['the layer switched off', { enabled: false }],
  ])('every route is a 404 with %s, and nothing is charged or read', async (_name, change) => {
    config = { ...config, ...change }
    for (const handler of Object.values(handlers)) {
      await expect(handler({ body: await subscription() })).rejects.toMatchObject({
        statusCode: 404,
      })
    }
    expect(calls).toEqual([])
    expect((await stored()).results).toEqual([])
  })
})

describe('signed out', () => {
  it('no route stores, removes or reports anything', async () => {
    signedInAs = null
    for (const handler of Object.values(handlers)) {
      await expect(handler({ body: await subscription() })).rejects.toMatchObject({
        statusCode: 401,
      })
    }
    expect((await stored()).results).toEqual([])
  })
})

describe('subscribe, status, unsubscribe', () => {
  it('stores the browser’s subscription for the signed-in account and reports it', async () => {
    expect(await handlers['subscribe.post']!({ body: await subscription() })).toEqual({
      subscribed: true,
    })
    expect((await stored()).results).toEqual([{ user_id: 'user-ada', endpoint: PHONE }])
    expect(await handlers['status.post']!({ body: { endpoint: PHONE } })).toEqual({
      subscribed: true,
    })
  })

  it('reports off to the next account that signs in on the same browser', async () => {
    await handlers['subscribe.post']!({ body: await subscription() })
    signedInAs = 'user-grace'
    expect(await handlers['status.post']!({ body: { endpoint: PHONE } })).toEqual({
      subscribed: false,
    })
  })

  it('does not let one account remove another’s subscription', async () => {
    await handlers['subscribe.post']!({ body: await subscription() })
    signedInAs = 'user-grace'
    expect(await handlers['unsubscribe.post']!({ body: { endpoint: PHONE } })).toEqual({
      subscribed: false,
    })
    expect((await stored()).results).toHaveLength(1)
  })

  it('removes the caller’s own, and answers the same when there was nothing to remove', async () => {
    await handlers['subscribe.post']!({ body: await subscription() })
    expect(await handlers['unsubscribe.post']!({ body: { endpoint: PHONE } })).toEqual({
      subscribed: false,
    })
    expect((await stored()).results).toEqual([])
    expect(await handlers['unsubscribe.post']!({ body: { endpoint: PHONE } })).toEqual({
      subscribed: false,
    })
  })

  it.each(['subscribe.post', 'status.post', 'unsubscribe.post'])(
    '%s refuses an endpoint that is not a push service',
    async (name) => {
      const body = await subscription('https://attacker.example/collect')
      await expect(handlers[name]!({ body })).rejects.toMatchObject({ statusCode: 400 })
      expect((await stored()).results).toEqual([])
    },
  )
})
