// The Stripe REST client slice: where it sends, what it sends, and which
// answers count as success. The network edge (global fetch) is the only fake.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRIPE_API_VERSION,
  StripeApiError,
  cancelSubscription,
  createCheckoutSession,
  createPortalLinks,
  findPaymentRefs,
  listCheckoutLineItems,
  stripeApiBase,
} from '../server/utils/stripe-api'

interface Recorded {
  url: string
  init: RequestInit
}

let requests: Recorded[]
let answer: (request: Recorded) => Response | Promise<Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  requests = []
  answer = () => json({})
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const request = { url, init }
    requests.push(request)
    return await answer(request)
  })
})
afterEach(() => vi.unstubAllGlobals())

const KEY = 'sk_test_abc'
const header = (request: Recorded | undefined, name: string) =>
  new Headers(request?.init.headers).get(name)
const bodyPairs = (request: Recorded | undefined) => [
  ...new URLSearchParams(String(request?.init.body)),
]

describe('stripeApiBase', () => {
  it('is Stripe unless overridden, and trims trailing slashes', () => {
    expect(stripeApiBase()).toBe('https://api.stripe.com')
    expect(stripeApiBase('')).toBe('https://api.stripe.com')
    expect(stripeApiBase('http://127.0.0.1:1///')).toBe('http://127.0.0.1:1')
  })

  it('applies to every client', async () => {
    answer = () => json({ url: 'https://x' })
    await createPortalLinks({
      secretKey: KEY,
      apiBase: 'http://127.0.0.1:2',
      customerId: 'cus_1',
      returnUrl: 'https://app/account',
    })
    expect(requests[0]?.url).toBe('http://127.0.0.1:2/v1/billing_portal/sessions')
  })
})

describe('createCheckoutSession', () => {
  const base = {
    secretKey: KEY,
    priceId: 'price_m',
    userId: 'user_1',
    successUrl: 'https://app/pricing?checkout=success',
    cancelUrl: 'https://app/pricing?checkout=canceled',
  }

  it('POSTs the exact subscription-mode form body with auth and version headers', async () => {
    answer = () => json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })
    const session = await createCheckoutSession({
      ...base,
      mode: 'subscription',
      customerEmail: 'a@b.co',
    })
    expect(session).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })

    const [request] = requests
    expect(request?.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(request?.init.method).toBe('POST')
    expect(header(request, 'authorization')).toBe(`Bearer ${KEY}`)
    expect(header(request, 'stripe-version')).toBe(STRIPE_API_VERSION)
    expect(header(request, 'content-type')).toBe('application/x-www-form-urlencoded')
    expect(bodyPairs(request)).toEqual([
      ['mode', 'subscription'],
      ['managed_payments[enabled]', 'true'],
      ['line_items[0][price]', 'price_m'],
      ['line_items[0][quantity]', '1'],
      ['success_url', 'https://app/pricing?checkout=success'],
      ['cancel_url', 'https://app/pricing?checkout=canceled'],
      ['client_reference_id', 'user_1'],
      ['metadata[userId]', 'user_1'],
      ['subscription_data[metadata][userId]', 'user_1'],
      ['customer_email', 'a@b.co'],
    ])
  })

  it('puts the account on the payment intent in payment mode', async () => {
    answer = () => json({ id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2' })
    await createCheckoutSession({ ...base, mode: 'payment', priceId: 'price_p' })
    const pairs = bodyPairs(requests[0])
    expect(pairs).toEqual([
      ['mode', 'payment'],
      ['managed_payments[enabled]', 'true'],
      ['line_items[0][price]', 'price_p'],
      ['line_items[0][quantity]', '1'],
      ['success_url', base.successUrl],
      ['cancel_url', base.cancelUrl],
      ['client_reference_id', 'user_1'],
      ['metadata[userId]', 'user_1'],
      ['payment_intent_data[metadata][userId]', 'user_1'],
    ])
  })

  it('sends customer, never customer_email too, when both are known', async () => {
    answer = () => json({ id: 'cs_3', url: 'https://x' })
    await createCheckoutSession({
      ...base,
      mode: 'subscription',
      customerId: 'cus_9',
      customerEmail: 'a@b.co',
    })
    const keys = bodyPairs(requests[0]).map(([k]) => k)
    expect(keys).toContain('customer')
    expect(keys).not.toContain('customer_email')
    expect(bodyPairs(requests[0]).find(([k]) => k === 'customer')?.[1]).toBe('cus_9')
  })

  it('throws when Stripe answers without a url', async () => {
    answer = () => json({ id: 'cs_4', url: null })
    await expect(createCheckoutSession({ ...base, mode: 'payment' })).rejects.toMatchObject({
      code: 'no_checkout_url',
    })
  })
})

describe('createPortalLinks', () => {
  const opts = { secretKey: KEY, customerId: 'cus_1', returnUrl: 'https://app/account' }

  it('mints one overview session and no deep links without a subscription', async () => {
    answer = () => json({ url: 'https://billing.stripe.com/p/overview' })
    const links = await createPortalLinks(opts)
    expect(links).toEqual({
      overviewUrl: 'https://billing.stripe.com/p/overview',
      cancelUrl: null,
      updatePaymentMethodUrl: null,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(requests[0]?.init.method).toBe('POST')
    expect(header(requests[0], 'authorization')).toBe(`Bearer ${KEY}`)
    expect(header(requests[0], 'stripe-version')).toBe(STRIPE_API_VERSION)
    expect(bodyPairs(requests[0])).toEqual([
      ['customer', 'cus_1'],
      ['return_url', 'https://app/account'],
    ])
  })

  it('also mints cancel and payment-method flows with a subscription', async () => {
    answer = (request) => {
      const flow = new URLSearchParams(String(request.init.body)).get('flow_data[type]')
      return json({ url: `https://billing.stripe.com/p/${flow ?? 'overview'}` })
    }
    const links = await createPortalLinks({ ...opts, subscriptionId: 'sub_1' })
    expect(links).toEqual({
      overviewUrl: 'https://billing.stripe.com/p/overview',
      cancelUrl: 'https://billing.stripe.com/p/subscription_cancel',
      updatePaymentMethodUrl: 'https://billing.stripe.com/p/payment_method_update',
    })
    expect(requests).toHaveLength(3)
    const cancel = requests.find((r) => String(r.init.body).includes('subscription_cancel'))
    expect(bodyPairs(cancel)).toEqual([
      ['customer', 'cus_1'],
      ['return_url', 'https://app/account'],
      ['flow_data[type]', 'subscription_cancel'],
      ['flow_data[subscription_cancel][subscription]', 'sub_1'],
    ])
    const update = requests.find((r) => String(r.init.body).includes('payment_method_update'))
    expect(bodyPairs(update)).toEqual([
      ['customer', 'cus_1'],
      ['return_url', 'https://app/account'],
      ['flow_data[type]', 'payment_method_update'],
    ])
  })

  it('throws when a session has no url', async () => {
    answer = () => json({})
    await expect(createPortalLinks(opts)).rejects.toMatchObject({ code: 'no_portal_url' })
  })
})

describe('cancelSubscription', () => {
  const cancel = (extra: { apiBase?: string; subscriptionId?: string } = {}) =>
    cancelSubscription({ secretKey: KEY, subscriptionId: 'sub_1', ...extra })

  it('DELETEs the subscription with the key as a bearer token and a pinned version', async () => {
    expect(await cancel()).toBe('canceled')
    const [request] = requests
    expect(request?.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1')
    expect(request?.init.method).toBe('DELETE')
    expect(request?.init.body).toBeUndefined()
    expect(header(request, 'authorization')).toBe(`Bearer ${KEY}`)
    expect(header(request, 'stripe-version')).toBe(STRIPE_API_VERSION)
  })

  it('encodes the id into the path', async () => {
    await cancel({ subscriptionId: 'sub/../x' })
    expect(requests[0]?.url).toBe('https://api.stripe.com/v1/subscriptions/sub%2F..%2Fx')
  })

  it('resolves already_canceled when the DELETE fails but the GET says canceled', async () => {
    answer = (request) =>
      request.init.method === 'DELETE'
        ? json({ error: { code: 'resource_missing' } }, 400)
        : json({ id: 'sub_1', status: 'canceled' })
    expect(await cancel()).toBe('already_canceled')
    expect(requests.map((r) => r.init.method)).toEqual(['DELETE', 'GET'])
    expect(requests[1]?.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1')
  })

  it('resolves already_canceled when the follow-up GET is a 404', async () => {
    answer = (request) =>
      request.init.method === 'DELETE'
        ? json({ error: { code: 'resource_missing' } }, 400)
        : json({ error: { code: 'resource_missing' } }, 404)
    expect(await cancel()).toBe('already_canceled')
  })

  it('rethrows the original error when the GET shows a live subscription', async () => {
    answer = (request) =>
      request.init.method === 'DELETE'
        ? json({ error: { code: 'subscription_locked' } }, 400)
        : json({ status: 'active' })
    await expect(cancel()).rejects.toMatchObject({ status: 400, code: 'subscription_locked' })
  })

  it.each([401, 403])('throws on %i without looking the subscription up', async (status) => {
    answer = () => json({ error: { code: 'forbidden' } }, status)
    const error = await cancel().catch((e) => e)
    expect(error).toBeInstanceOf(StripeApiError)
    expect(error).toMatchObject({ status })
    expect(requests).toHaveLength(1)
  })

  it('throws on a 5xx without looking the subscription up', async () => {
    answer = () => json({ error: { code: 'api_error' } }, 503)
    await expect(cancel()).rejects.toMatchObject({ status: 503, code: 'api_error' })
    expect(requests).toHaveLength(1)
  })

  it('never carries the error body text on the thrown error', async () => {
    answer = () =>
      json(
        { error: { code: 'forbidden', message: 'secret detail for jane@example.com', type: 'x' } },
        403,
      )
    const error = await cancel().catch((e) => e)
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
    expect(String(error.message)).not.toContain('secret')
    expect(String(error.message)).not.toContain('jane')
    expect(JSON.stringify(error)).not.toContain('secret')
  })

  it('falls back to the error type, and drops a code that is not snake_case', async () => {
    answer = () => json({ error: { type: 'invalid_request_error' } }, 400)
    await expect(cancel()).rejects.toMatchObject({ code: 'invalid_request_error' })
    answer = (request) =>
      request.init.method === 'DELETE'
        ? json({ error: { code: 'Has Spaces & more' } }, 400)
        : json({ status: 'active' })
    await expect(cancel()).rejects.toMatchObject({ status: 400, code: null })
  })

  it('keeps only the status when the error body is not JSON', async () => {
    answer = () => new Response('<html>Bad gateway</html>', { status: 502 })
    const error = await cancel().catch((e) => e)
    expect(error).toMatchObject({ status: 502, code: null })
    expect(String(error.message)).not.toContain('html')
  })

  it('reports a network failure as status 0', async () => {
    answer = () => Promise.reject(new TypeError('boom'))
    await expect(cancel()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})

describe('listCheckoutLineItems', () => {
  it('GETs the session line items and flattens price and product ids', async () => {
    answer = () =>
      json({
        data: [
          { price: { id: 'price_a', product: 'prod_a' } },
          { price: { id: 'price_b', product: { id: 'prod_b' } } },
          { price: null },
        ],
      })
    const items = await listCheckoutLineItems({ secretKey: KEY, sessionId: 'cs_1' })
    expect(items).toEqual([
      { price: { id: 'price_a', product_id: 'prod_a' } },
      { price: { id: 'price_b', product_id: 'prod_b' } },
      { price: null },
    ])
    expect(requests[0]?.url).toBe(
      'https://api.stripe.com/v1/checkout/sessions/cs_1/line_items?limit=20',
    )
    expect(requests[0]?.init.method).toBe('GET')
    expect(requests[0]?.init.body).toBeUndefined()
    expect(header(requests[0], 'authorization')).toBe(`Bearer ${KEY}`)
  })

  it('returns an empty list when Stripe sends no data', async () => {
    answer = () => json({})
    expect(await listCheckoutLineItems({ secretKey: KEY, sessionId: 'cs_1' })).toEqual([])
  })
})

describe('findPaymentRefs', () => {
  const find = () => findPaymentRefs({ secretKey: KEY, paymentIntentId: 'pi_1' })

  it('queries invoice_payments by payment intent with the invoice expanded', async () => {
    answer = () =>
      json({
        data: [
          {
            invoice: {
              id: 'in_1',
              parent: { subscription_details: { subscription: 'sub_1' } },
            },
          },
        ],
      })
    expect(await find()).toEqual({ invoiceId: 'in_1', subscriptionId: 'sub_1' })
    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.stripe.com/v1/invoice_payments')
    expect([...url.searchParams]).toEqual([
      ['payment[type]', 'payment_intent'],
      ['payment[payment_intent]', 'pi_1'],
      ['expand[]', 'data.invoice'],
      ['limit', '1'],
    ])
  })

  it('reads an expanded subscription object too', async () => {
    answer = () =>
      json({
        data: [
          {
            invoice: {
              id: 'in_2',
              parent: { subscription_details: { subscription: { id: 'sub_2' } } },
            },
          },
        ],
      })
    expect(await find()).toEqual({ invoiceId: 'in_2', subscriptionId: 'sub_2' })
  })

  it('handles an invoice that came back as a bare string', async () => {
    answer = () => json({ data: [{ invoice: 'in_3' }] })
    expect(await find()).toEqual({ invoiceId: 'in_3', subscriptionId: null })
  })

  it('has no subscription for an invoice with no parent', async () => {
    answer = () => json({ data: [{ invoice: { id: 'in_4' } }] })
    expect(await find()).toEqual({ invoiceId: 'in_4', subscriptionId: null })
  })

  it('is null for a payment with no invoice', async () => {
    answer = () => json({ data: [] })
    expect(await find()).toBeNull()
  })
})
