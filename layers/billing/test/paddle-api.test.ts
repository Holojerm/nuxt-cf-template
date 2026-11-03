// The Paddle REST client slice: where it sends, what it sends, and which
// answers count as success. The network edge (global fetch) is the only fake.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PaddleApiError,
  cancelSubscription,
  createPortalSession,
  paddleApiBase,
} from '../server/utils/paddle-api'

let requests: { url: string; init: RequestInit }[]
let answer: () => Response | Promise<Response>

beforeEach(() => {
  requests = []
  answer = () => new Response('{}', { status: 200 })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return await answer()
  })
})
afterEach(() => vi.unstubAllGlobals())

const cancel = (extra: { apiBase?: string; environment?: string } = {}) =>
  cancelSubscription({
    apiKey: 'k_test',
    environment: 'sandbox',
    subscriptionId: 'sub_1',
    ...extra,
  })

describe('paddleApiBase', () => {
  it('is the sandbox host unless production, and the override wins when set', () => {
    expect(paddleApiBase('sandbox')).toBe('https://sandbox-api.paddle.com')
    expect(paddleApiBase('anything')).toBe('https://sandbox-api.paddle.com')
    expect(paddleApiBase('production')).toBe('https://api.paddle.com')
    expect(paddleApiBase('production', '')).toBe('https://api.paddle.com')
    expect(paddleApiBase('production', 'http://127.0.0.1:1/')).toBe('http://127.0.0.1:1')
  })

  it('applies to the portal client too', async () => {
    answer = () =>
      new Response(JSON.stringify({ data: { urls: { general: { overview: 'https://x' } } } }))
    await createPortalSession({
      apiKey: 'k',
      environment: 'sandbox',
      apiBase: 'http://127.0.0.1:2',
      customerId: 'ctm_1',
    })
    expect(requests[0]?.url).toBe('http://127.0.0.1:2/customers/ctm_1/portal-sessions')
  })
})

describe('cancelSubscription', () => {
  it('POSTs effective_from: immediately, with the key as a bearer token', async () => {
    expect(await cancel()).toBe('canceled')
    const [request] = requests
    expect(request?.url).toBe('https://sandbox-api.paddle.com/subscriptions/sub_1/cancel')
    expect(request?.init.method).toBe('POST')
    expect(JSON.parse(String(request?.init.body))).toEqual({ effective_from: 'immediately' })
    expect(new Headers(request?.init.headers).get('authorization')).toBe('Bearer k_test')
  })

  it('encodes the id into the path', async () => {
    await cancelSubscription({ apiKey: 'k', environment: 'sandbox', subscriptionId: 'sub/../x' })
    expect(requests[0]?.url).toBe(
      'https://sandbox-api.paddle.com/subscriptions/sub%2F..%2Fx/cancel',
    )
  })

  it.each(['subscription_is_canceled_action_invalid', 'subscription_update_when_canceled'])(
    'resolves already_canceled for Paddle’s %s',
    async (code) => {
      answer = () => new Response(JSON.stringify({ error: { code } }), { status: 400 })
      expect(await cancel()).toBe('already_canceled')
    },
  )

  it('throws a PaddleApiError carrying status and code, never the body', async () => {
    answer = () =>
      new Response(JSON.stringify({ error: { code: 'forbidden', detail: 'secret detail' } }), {
        status: 403,
      })
    const error = await cancel().catch((e) => e)
    expect(error).toBeInstanceOf(PaddleApiError)
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
    expect(String(error.message)).not.toContain('secret')
  })

  it('does not treat the already-cancelled code on another status as success', async () => {
    answer = () =>
      new Response(JSON.stringify({ error: { code: 'subscription_is_canceled_action_invalid' } }), {
        status: 409,
      })
    await expect(cancel()).rejects.toMatchObject({ status: 409 })
  })

  it('drops an error code that is not a short snake_case token', async () => {
    answer = () =>
      new Response(JSON.stringify({ error: { code: 'Has Spaces & more' } }), { status: 400 })
    await expect(cancel()).rejects.toMatchObject({ status: 400, code: null })
  })

  it('reports a network failure as status 0', async () => {
    answer = () => Promise.reject(new TypeError('boom'))
    await expect(cancel()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})
