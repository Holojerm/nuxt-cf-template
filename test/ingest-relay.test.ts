// The /ingest relay's settings and the route that reads them. The route is an
// H3 handler reaching for Nitro auto-imports, so the globals it needs are
// stubbed and h3's network edge (`sendProxy`) is replaced; what is under test is
// what the route asks the limiter for and what it hands upstream.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureIngestRelay,
  getForwardClientIp,
  getIngestLimiter,
  resetIngestRelayForTest,
} from '../server/utils/ingest-relay'
import { hashedClientIp, NATIVE_LIMITER } from '../server/utils/rate-limit'

const h3 = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  body: undefined as Uint8Array | undefined,
  sendProxy: vi.fn(async (_event: unknown, _target: string, _opts: unknown) => 'proxied'),
}))

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('h3')>()),
  getRequestHeaders: () => h3.headers,
  readRawBody: async () => h3.body,
  sendProxy: h3.sendProxy,
}))

const rateLimit = vi.fn(async (_event: unknown, _opts: unknown) => {})

type Handler = (event: unknown) => Promise<unknown>
let handler: Handler

function fakeEvent(path: string, search = '', method = 'POST') {
  return { method, path, search }
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('getRouterParam', (event: { path: string }) =>
    event.path.replace(/^\/ingest\//, ''),
  )
  vi.stubGlobal('getRequestURL', (event: { search: string }) => ({ search: event.search }))
  vi.stubGlobal('rateLimit', rateLimit)
  vi.stubGlobal('hashedClientIp', async () => 'hashed-ip')
  handler = (await import('../server/routes/ingest/[...path]')).default as unknown as Handler
})

beforeEach(() => {
  resetIngestRelayForTest()
  rateLimit.mockClear()
  h3.sendProxy.mockClear()
  h3.headers = {}
  h3.body = undefined
})

afterEach(() => resetIngestRelayForTest())

describe('configureIngestRelay', () => {
  it('is off until an app turns it on, and still forwards the client address', () => {
    expect(getIngestLimiter()).toBeNull()
    expect(getForwardClientIp()).toBe(true)
    configureIngestRelay({ forwardClientIp: false })
    expect(getIngestLimiter()).toBeNull()
  })

  it('defaults to 300 requests per 120s once on, a budget the native binding cannot take', () => {
    configureIngestRelay({ rateLimit: true })
    const limiter = getIngestLimiter()!
    expect(limiter).toEqual({ name: 'ingest', limit: 300, windowSeconds: 120 })
    expect(limiter.windowSeconds === NATIVE_LIMITER.windowSeconds).toBe(false)
  })

  it('overrides only what it is given, and a number implies on', () => {
    configureIngestRelay({ limit: 50 })
    expect(getIngestLimiter()).toEqual({ name: 'ingest', limit: 50, windowSeconds: 120 })
    configureIngestRelay({ windowSeconds: 30, forwardClientIp: false })
    expect(getIngestLimiter()).toEqual({ name: 'ingest', limit: 300, windowSeconds: 30 })
    expect(getForwardClientIp()).toBe(false)
  })

  it('refuses a budget that is not a positive integer', () => {
    expect(() => configureIngestRelay({ limit: 0 })).toThrow(/limit/)
    expect(() => configureIngestRelay({ limit: 1.5 })).toThrow(/limit/)
    expect(() => configureIngestRelay({ windowSeconds: -1 })).toThrow(/windowSeconds/)
    expect(getIngestLimiter()).toBeNull()
  })
})

describe('the /ingest route', () => {
  it('does not rate-limit an app that never turned the limiter on', async () => {
    await handler(fakeEvent('/ingest/e/'))
    expect(rateLimit).not.toHaveBeenCalled()
    expect(h3.sendProxy).toHaveBeenCalledTimes(1)
  })

  it('rate-limits by hashed address with the configured budget, before anything is forwarded', async () => {
    configureIngestRelay({ rateLimit: true })
    await handler(fakeEvent('/ingest/e/'))
    expect(rateLimit).toHaveBeenCalledTimes(1)
    expect(rateLimit.mock.calls[0]![1]).toEqual({
      name: 'ingest',
      limit: 300,
      windowSeconds: 120,
      identifier: 'hashed-ip',
    })

    configureIngestRelay({ limit: 10, windowSeconds: 20 })
    await handler(fakeEvent('/ingest/e/'))
    expect(rateLimit.mock.calls[1]![1]).toMatchObject({ limit: 10, windowSeconds: 20 })
  })

  it('forwards nothing when the limiter refuses', async () => {
    configureIngestRelay({ rateLimit: true })
    rateLimit.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { statusCode: 429 }),
    )
    await expect(handler(fakeEvent('/ingest/e/'))).rejects.toMatchObject({ statusCode: 429 })
    expect(h3.sendProxy).not.toHaveBeenCalled()
  })

  it('sends static/ paths to the assets host and everything else to the API host, query kept', async () => {
    await handler(fakeEvent('/ingest/static/array.js', '?v=1', 'GET'))
    await handler(fakeEvent('/ingest/e/', '?ip=1&ver=1.2'))
    expect(h3.sendProxy.mock.calls[0]![1]).toBe(
      'https://us-assets.i.posthog.com/static/array.js?v=1',
    )
    expect(h3.sendProxy.mock.calls[1]![1]).toBe('https://us.i.posthog.com/e/?ip=1&ver=1.2')
  })

  it('builds upstream headers from the allowlist: no cookie, no authorization, referer without its query', async () => {
    h3.headers = {
      cookie: 'nuxt-session=sealed',
      authorization: 'Bearer live-token',
      'content-type': 'application/json',
      referer: 'https://app.example.com/auth/verify?token=secret#frag',
      'cf-connecting-ip': '203.0.113.5',
    }
    await handler(fakeEvent('/ingest/e/'))
    const opts = h3.sendProxy.mock.calls[0]![2] as { headers: Record<string, string> }
    expect(opts.headers).toEqual({
      'content-type': 'application/json',
      referer: 'https://app.example.com/auth/verify',
      // The default is to tell PostHog where the visitor is.
      'x-forwarded-for': '203.0.113.5',
    })
  })

  it('tells PostHog nothing about the visitor when configured not to', async () => {
    configureIngestRelay({ forwardClientIp: false })
    h3.headers = { 'cf-connecting-ip': '203.0.113.5', 'content-type': 'application/json' }
    await handler(fakeEvent('/ingest/e/'))
    const opts = h3.sendProxy.mock.calls[0]![2] as { headers: Record<string, string> }
    expect(opts.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('forwards the method and the raw body of a payload method, and no body for a GET', async () => {
    h3.body = new Uint8Array([1, 2, 3])
    await handler(fakeEvent('/ingest/e/', '', 'POST'))
    await handler(fakeEvent('/ingest/decide/', '', 'GET'))
    const post = h3.sendProxy.mock.calls[0]![2] as {
      fetchOptions: { method: string; body?: Uint8Array; redirect: string }
    }
    const get = h3.sendProxy.mock.calls[1]![2] as typeof post
    expect(post.fetchOptions.method).toBe('POST')
    expect([...post.fetchOptions.body!]).toEqual([1, 2, 3])
    expect(post.fetchOptions.redirect).toBe('manual')
    expect(get.fetchOptions.method).toBe('GET')
    expect(get.fetchOptions.body).toBeUndefined()
  })
})

describe('hashedClientIp', () => {
  const asEvent = (headers: Record<string, string>) =>
    ({ node: { req: { headers } }, headers: new Headers(headers) }) as never

  beforeAll(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ sessionPassword: 'salt-one' }))
    vi.stubGlobal(
      'getRequestHeader',
      (event: { headers: Headers }, name: string) => event.headers.get(name) ?? undefined,
    )
  })

  it('is 32 hex characters, stable per address, and never the address itself', async () => {
    const a = await hashedClientIp(asEvent({ 'cf-connecting-ip': '203.0.113.5' }))
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).toBe(await hashedClientIp(asEvent({ 'cf-connecting-ip': '203.0.113.5' })))
    expect(a).not.toContain('203')
    expect(a).not.toBe(await hashedClientIp(asEvent({ 'cf-connecting-ip': '203.0.113.6' })))
  })

  it('is salted: another deployment gets other digests', async () => {
    const event = asEvent({ 'cf-connecting-ip': '203.0.113.5' })
    const before = await hashedClientIp(event)
    vi.stubGlobal('useRuntimeConfig', () => ({ sessionPassword: 'salt-two' }))
    expect(await hashedClientIp(event)).not.toBe(before)
  })
})
