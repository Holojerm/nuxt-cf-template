// POST /stripe/webhook, driven as a function against a real D1 inside workerd.
//
// The route is a Nitro handler that leans on auto-imports, which do not exist
// under vitest, so each is stubbed as the global it would resolve to — with the
// REAL implementation wherever there is one (the signature check, the schema,
// applyBillingEvent, the ops spool). Only the edges are fakes: the request, the
// runtime config, email, PostHog and the two Stripe lookups (global fetch). What this pins is the contract the replay
// script (test/replay/) checks end to end against a built Worker: the status
// codes, and which deliveries raise an ops alert and which are only a log line.

import { env } from 'cloudflare:test'
import { createError } from 'h3'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount } from '~~/server/utils/account'
import { clearExtensionsForTest } from '~~/server/utils/extensions'
import { logEvent, pathForLog } from '~~/server/utils/log'
import {
  recordOpsEvent,
  recordUnauthenticatedOpsEvent,
  resetUnauthenticatedOpsThrottleForTest,
} from '~~/server/utils/ops'
import { billingSubscriptionEvent } from '#shared/utils/analytics-events'
import { registerBillingExtensions } from '../server/utils/billing-extensions'
import {
  clearBillingOutcomeHandlersForTest,
  registerBillingOutcomeHandler,
  runBillingOutcomeHandlers,
} from '~~/server/utils/billing-outcome'
import {
  clearUnknownUserExpectationsForTest,
  isUnknownUserExpected,
  registerUnknownUserExpectation,
} from '../server/utils/billing-expectations'
import { adjustmentMatchedNothing, applyBillingEvent } from '../server/utils/entitlements'
import { clearEntitlementViewFieldsForTest } from '~~/server/utils/entitlement-view-fields'
import { verifyStripeSignature } from '../server/utils/stripe'
import { StripeApiError, findPaymentRefs, listCheckoutLineItems } from '../server/utils/stripe-api'
import {
  StripeEventShapeError,
  normalizeStripeEvent,
  stripeEventSchema,
} from '../server/utils/stripe-events'
import { isForeignProduct, priceCatalogue } from '../server/utils/stripe-prices'

const db = drizzle(env.DB, { schema })
const SECRET = 'whsec_route_test'
const USER = 'user-route'
const PRICE_PASS = 'price_route_pass'
const PRICE_MONTHLY = 'price_route_monthly'
const OWN_PRODUCT = 'prod_route_own'

interface Config {
  stripe: { webhookSecret: string; secretKey: string; productId: string; apiBase: string }
  billing: { alertUnmatchedAdjustments: boolean; analytics?: boolean }
  public: { stripePricePass: string; stripePriceMonthly: string }
}

let config: Config
let raw: string | undefined
let header: string | undefined
let captured: { event: string }[]
let logs: Record<'warn' | 'info' | 'error', ReturnType<typeof vi.spyOn>>
let eventSeq = 0
let fetched: string[]
let lineItems: unknown[]
let paymentList: () => Response

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Handler = (event: unknown) => Promise<{ received: boolean }>
let handler: Handler

beforeEach(async () => {
  eventSeq = 0
  fetched = []
  lineItems = []
  paymentList = () => json({ data: [] })
  captured = []
  config = {
    stripe: { webhookSecret: SECRET, secretKey: 'sk_test_route', productId: '', apiBase: '' },
    billing: { alertUnmatchedAdjustments: true },
    public: { stripePricePass: PRICE_PASS, stripePriceMonthly: PRICE_MONTHLY },
  }
  await env.DB.exec('DELETE FROM ops_events')
  await env.DB.exec('DELETE FROM billing_events')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ id: USER, email: 'route@example.com', name: 'Route' })

  vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
  vi.stubGlobal('useRuntimeConfig', () => config)
  vi.stubGlobal('db', db)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('readRawBody', async () => raw)
  vi.stubGlobal('getRequestHeader', () => header)
  vi.stubGlobal('recordOpsEvent', recordOpsEvent)
  vi.stubGlobal('recordUnauthenticatedOpsEvent', recordUnauthenticatedOpsEvent)
  vi.stubGlobal('pathForLog', pathForLog)
  vi.stubGlobal('logEvent', logEvent)
  vi.stubGlobal('verifyStripeSignature', verifyStripeSignature)
  vi.stubGlobal('stripeEventSchema', stripeEventSchema)
  vi.stubGlobal('normalizeStripeEvent', normalizeStripeEvent)
  vi.stubGlobal('StripeEventShapeError', StripeEventShapeError)
  vi.stubGlobal('StripeApiError', StripeApiError)
  vi.stubGlobal('listCheckoutLineItems', listCheckoutLineItems)
  vi.stubGlobal('findPaymentRefs', findPaymentRefs)
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url)
    if (url.includes('/line_items')) return json({ data: lineItems })
    if (url.includes('/invoice_payments')) return paymentList()
    return json({ error: { code: 'unexpected' } }, 500)
  })
  vi.stubGlobal('applyBillingEvent', applyBillingEvent)
  vi.stubGlobal('priceCatalogue', priceCatalogue)
  vi.stubGlobal('isForeignProduct', isForeignProduct)
  vi.stubGlobal('adjustmentMatchedNothing', adjustmentMatchedNothing)
  vi.stubGlobal('runBillingOutcomeHandlers', runBillingOutcomeHandlers)
  vi.stubGlobal('isUnknownUserExpected', isUnknownUserExpected)
  vi.stubGlobal('billingSubscriptionEvent', billingSubscriptionEvent)
  vi.stubGlobal('notifyBillingOutcome', async () => {})
  vi.stubGlobal('captureServerEvent', async (e: { event: string }) => void captured.push(e))
  logs = {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  }

  vi.resetModules()
  handler = (await import('../server/routes/stripe/webhook.post')).default as unknown as Handler
})

afterEach(() => {
  resetUnauthenticatedOpsThrottleForTest()
  clearBillingOutcomeHandlersForTest()
  clearUnknownUserExpectationsForTest()
  clearExtensionsForTest()
  clearEntitlementViewFieldsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function sign(body: string, secret = SECRET, ageSeconds = 0): Promise<string> {
  const ts = Math.floor(Date.now() / 1000) - ageSeconds
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`))
  const h1 = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${ts},v1=${h1}`
}

/** Deliver `body` signed (or not) and report the status the route answers with. */
async function deliver(body: string, opts: { secret?: string; age?: number } = {}) {
  raw = body
  header = await sign(body, opts.secret, opts.age)
  try {
    const result = await handler({ path: '/stripe/webhook' })
    return { status: 200, result }
  } catch (error) {
    return { status: (error as { statusCode: number }).statusCode }
  }
}

const CREATED = 4_070_908_800 // 2099-01-01, whole seconds as Stripe sends them

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  eventId = `evt_route_${++eventSeq}`,
) {
  return JSON.stringify({ id: eventId, type, created: CREATED, data: { object } })
}

/** A paid one-time Checkout Session; the line items come from the stubbed lookup. */
const purchase = (priceId: string, productId: string | null, userId: string | null = USER) => {
  lineItems = [{ price: { id: priceId, product: productId } }]
  const n = ++eventSeq
  return stripeEvent('checkout.session.completed', {
    id: `cs_route_${n}`,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: `pi_route_${n}`,
    metadata: userId ? { userId } : null,
  })
}

const subscription = (type: string, userId: string, status = 'canceled', priceId = PRICE_MONTHLY) =>
  stripeEvent(type, {
    id: 'sub_route_echo',
    status,
    metadata: { userId },
    items: {
      data: [{ current_period_end: CREATED, price: { id: priceId, product: OWN_PRODUCT } }],
    },
  })

async function opsKinds(): Promise<string[]> {
  const rows = await db.select().from(schema.opsEvents)
  return rows.map((row) => row.kind).sort()
}

describe('what the route refuses', () => {
  it('503s and alerts when the secret is unset', async () => {
    config.stripe.webhookSecret = ''
    expect((await deliver(purchase(PRICE_PASS, null))).status).toBe(503)
    expect(await opsKinds()).toEqual(['stripe_webhook_unconfigured'])
  })

  it('503s and alerts when the API key is unset, naming it', async () => {
    config.stripe.secretKey = ''
    expect((await deliver(purchase(PRICE_PASS, null))).status).toBe(503)
    expect(await opsKinds()).toEqual(['stripe_webhook_unconfigured'])
    const [row] = await db.select().from(schema.opsEvents)
    expect(row?.detail).toContain('NUXT_STRIPE_SECRET_KEY')
    expect(fetched).toEqual([])
  })

  it('401s a wrong secret and a stale timestamp, each with an alert', async () => {
    expect((await deliver(purchase(PRICE_PASS, null), { secret: 'nope' })).status).toBe(401)
    expect((await deliver(purchase(PRICE_PASS, null), { age: 301 })).status).toBe(401)
    expect(await opsKinds()).toEqual(['stripe_webhook_rejected', 'stripe_webhook_rejected'])
  })

  it('records a flood of bad signatures as one alert, still 401ing every request', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await deliver(purchase(PRICE_PASS, null), { secret: 'nope' })).status).toBe(401)
    }
    expect(await opsKinds()).toEqual(['stripe_webhook_rejected'])
  })

  it('400s a signed body that is not JSON (not a 500) and one that is not a Stripe event', async () => {
    expect((await deliver('{ definitely not json')).status).toBe(400)
    expect((await deliver(JSON.stringify({ hello: 'world' }))).status).toBe(400)
    expect(await opsKinds()).toEqual(['stripe_webhook_unparseable', 'stripe_webhook_unparseable'])
  })

  it('400s a body that is JSON null', async () => {
    expect((await deliver('null')).status).toBe(400)
  })
})

describe('Stripe lookups and event shapes', () => {
  it('502s, alerts and writes nothing when a lookup at Stripe fails, so Stripe redelivers', async () => {
    const body = purchase(PRICE_PASS, OWN_PRODUCT)
    vi.stubGlobal('fetch', async () => json({ error: { code: 'api_error' } }, 500))
    expect((await deliver(body)).status).toBe(502)
    expect(await opsKinds()).toEqual(['stripe_webhook_lookup_failed'])
    expect(await db.select().from(schema.entitlements)).toHaveLength(0)
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('stripe_webhook_lookup_failed'))
    const [row] = await db.select().from(schema.opsEvents)
    expect(row?.detail).toContain('status 500, code api_error')
  })

  it('502s on a network failure to Stripe', async () => {
    const body = purchase(PRICE_PASS, OWN_PRODUCT)
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    expect((await deliver(body)).status).toBe(502)
    expect(await opsKinds()).toEqual(['stripe_webhook_lookup_failed'])
  })

  it('looks the line items up for a pass, and the invoice for a refund', async () => {
    await deliver(purchase(PRICE_PASS, OWN_PRODUCT))
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toContain('/v1/checkout/sessions/cs_route_1/line_items')
    await deliver(
      stripeEvent('charge.refunded', { id: 'ch_x', payment_intent: 'pi_x', refunded: true }),
    )
    expect(fetched[1]).toContain('/v1/invoice_payments')
  })

  it('acknowledges event types it does not act on without any lookup', async () => {
    expect((await deliver(stripeEvent('customer.created', { id: 'cus_1' }))).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(fetched).toEqual([])
  })

  it('400s and alerts a handled event whose object has the wrong shape', async () => {
    expect(
      (await deliver(stripeEvent('customer.subscription.updated', { id: 'sub_1' }))).status,
    ).toBe(400)
    expect(await opsKinds()).toEqual(['stripe_webhook_unparseable'])
  })

  it('does not write a row for a subscription whose first payment never completed', async () => {
    expect(
      (await deliver(subscription('customer.subscription.created', USER, 'incomplete'))).status,
    ).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(await db.select().from(schema.entitlements)).toHaveLength(0)
  })
})

describe('what it acknowledges but flags', () => {
  it('grants a configured pass: 200, no alert', async () => {
    expect((await deliver(purchase(PRICE_PASS, OWN_PRODUCT))).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(await db.select().from(schema.entitlements)).toHaveLength(1)
  })

  it('alerts on an unrecognised price and grants nothing', async () => {
    expect((await deliver(purchase('price_unlisted', OWN_PRODUCT))).status).toBe(200)
    expect(await opsKinds()).toEqual(['stripe_webhook_unrecognised_price'])
    expect(await db.select().from(schema.entitlements)).toHaveLength(0)
  })

  it('alerts on an unknown user, and on an event with no user at all', async () => {
    expect((await deliver(purchase(PRICE_PASS, null, 'user-ghost'))).status).toBe(200)
    expect((await deliver(purchase(PRICE_PASS, null, null))).status).toBe(200)
    expect(await opsKinds()).toEqual(['stripe_webhook_no_user', 'stripe_webhook_unknown_user'])
  })

  describe('an unknown user the app says to expect', () => {
    const canceled = (userId: string) => subscription('customer.subscription.deleted', userId)

    it('alerts as before when nothing is registered', async () => {
      await deliver(canceled('user-ghost'))
      expect(await opsKinds()).toEqual(['stripe_webhook_unknown_user'])
    })

    it('acknowledges with an info log, not an alert, when a check claims it', async () => {
      registerUnknownUserExpectation('deletion', (e) => e.data.status === 'canceled')

      expect((await deliver(canceled('user-ghost'))).status).toBe(200)

      expect(await opsKinds()).toEqual([])
      expect(logs.info).toHaveBeenCalledWith(
        expect.stringContaining('"kind":"stripe_webhook_after_deletion"'),
      )
      // Only what the check names: a purchase for a missing account still alerts.
      await deliver(purchase(PRICE_PASS, null, 'user-ghost'))
      expect(await opsKinds()).toEqual(['stripe_webhook_unknown_user'])
    })

    it('treats a check that throws as not expected, so the alert is never lost', async () => {
      registerUnknownUserExpectation('broken', () => {
        throw new Error('boom')
      })

      await deliver(canceled('user-ghost'))

      expect(await opsKinds()).toEqual(['stripe_webhook_unknown_user'])
    })
  })

  describe('the echo of billing.cancelOnDeletion’s own cancel', () => {
    const echo = (userId: string, status = 'canceled', type = 'customer.subscription.deleted') =>
      subscription(type, userId, status)

    beforeEach(() => {
      registerBillingExtensions(
        { cancelOnDeletion: true },
        { cancelSubscription: async () => 'canceled' },
      )
    })

    it('for a deleted account that kept its tombstone row: applied to the retained entitlement, 200, no alert', async () => {
      await db.insert(schema.entitlements).values({
        userId: USER,
        billingRef: 'sub_route_echo',
        status: 'active',
        productKey: 'default',
      })
      expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })

      expect((await deliver(echo(USER))).status).toBe(200)

      expect(await opsKinds()).toEqual([])
      const [row] = await db.select().from(schema.entitlements)
      expect(row?.status).toBe('canceled')
    })

    it('for an account whose row is gone: 200, an info log and no alert', async () => {
      expect((await deliver(echo('user-ghost'))).status).toBe(200)

      expect(await opsKinds()).toEqual([])
      expect(logs.info).toHaveBeenCalledWith(
        expect.stringContaining('"kind":"stripe_webhook_after_deletion"'),
      )
    })

    it('stays narrow: anything but a cancelled subscription for a missing account still alerts', async () => {
      await deliver(echo('user-ghost', 'active', 'customer.subscription.created'))
      await deliver(purchase(PRICE_PASS, null, 'user-ghost'))

      expect(await opsKinds()).toEqual([
        'stripe_webhook_unknown_user',
        'stripe_webhook_unknown_user',
      ])
    })
  })

  it('does not alert on duplicates or out-of-order events (expected traffic)', async () => {
    const body = purchase(PRICE_PASS, null)
    await deliver(body)
    expect((await deliver(body)).status).toBe(200)
    expect(await opsKinds()).toEqual([])
  })
})

describe('a shared Stripe account (NUXT_STRIPE_PRODUCT_ID)', () => {
  it('without a product id configured, another product’s sale is an unrecognised price', async () => {
    await deliver(purchase('price_other', 'prod_other'))
    expect(await opsKinds()).toEqual(['stripe_webhook_unrecognised_price'])
  })

  it('with one, a sale on another product is an info log and no alert', async () => {
    config.stripe.productId = OWN_PRODUCT
    expect((await deliver(purchase('price_other', 'prod_other'))).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(logs.info).toHaveBeenCalledWith(
      expect.stringContaining('stripe_webhook_foreign_product'),
    )
  })

  it('with one, an unlisted price on OUR product still alerts', async () => {
    config.stripe.productId = OWN_PRODUCT
    await deliver(purchase('price_unlisted', OWN_PRODUCT))
    expect(await opsKinds()).toEqual(['stripe_webhook_unrecognised_price'])
  })

  it('with one, a basket mixing ours and another product still alerts', async () => {
    config.stripe.productId = OWN_PRODUCT
    lineItems = [
      { price: { id: 'price_other', product: 'prod_other' } },
      { price: { id: 'price_unlisted', product: OWN_PRODUCT } },
    ]
    await deliver(
      stripeEvent('checkout.session.completed', {
        id: 'cs_mixed',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_mixed',
        metadata: { userId: USER },
      }),
    )
    expect(await opsKinds()).toEqual(['stripe_webhook_unrecognised_price'])
  })
})

describe('refunds that match nothing', () => {
  const refund = (paymentIntent = 'pi_nobody') =>
    stripeEvent('charge.refunded', {
      id: `ch_${++eventSeq}`,
      payment_intent: paymentIntent,
      refunded: true,
    })

  it('alert by default', async () => {
    expect((await deliver(refund())).status).toBe(200)
    expect(await opsKinds()).toEqual(['stripe_adjustment_unmatched'])
  })

  it('stay a log line when billing.alertUnmatchedAdjustments is off', async () => {
    config.billing.alertUnmatchedAdjustments = false
    expect((await deliver(refund())).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('"kind":"billing_adjustment"'))
  })

  it('do not alert when the refund names a payment we granted', async () => {
    const body = purchase(PRICE_PASS, OWN_PRODUCT)
    await deliver(body)
    const session = (JSON.parse(body) as { data: { object: { payment_intent: string } } }).data
      .object
    await deliver(refund(session.payment_intent))
    expect(await opsKinds()).toEqual([])
  })
})

describe('outcome handlers', () => {
  it('run after the event is applied, with the outcome, before PostHog', async () => {
    const seen: string[] = []
    registerBillingOutcomeHandler('probe', async ({ outcome }) => {
      seen.push(`${outcome.kind}:captured=${captured.length}`)
    })
    await deliver(purchase(PRICE_PASS, OWN_PRODUCT))
    expect(seen).toEqual(['pass:captured=0'])
    expect(captured.map((c) => c.event)).toEqual(['billing_transaction_completed'])
  })

  it('a handler that throws does not fail the delivery or stop the next one', async () => {
    const ran: string[] = []
    registerBillingOutcomeHandler('boom', async () => {
      throw new Error('handler down')
    })
    registerBillingOutcomeHandler('after', async () => void ran.push('after'))
    expect((await deliver(purchase(PRICE_PASS, OWN_PRODUCT))).status).toBe(200)
    expect(ran).toEqual(['after'])
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('billing_outcome_handler_failed'),
    )
  })
})

describe('billing.analytics', () => {
  it('on by default (and when the key is absent): the layer’s billing_* events are sent', async () => {
    await deliver(purchase(PRICE_PASS, OWN_PRODUCT))
    expect(captured.map((c) => c.event)).toEqual(['billing_transaction_completed'])
  })

  it('off: nothing is sent to PostHog, and the delivery is otherwise unchanged', async () => {
    config.billing.analytics = false
    const seen: string[] = []
    registerBillingOutcomeHandler('probe', async ({ outcome }) => void seen.push(outcome.kind))
    expect((await deliver(purchase(PRICE_PASS, OWN_PRODUCT))).status).toBe(200)
    expect(captured).toEqual([])
    // The app's own handlers still run: that is how it records its own events.
    expect(seen).toEqual(['pass'])
    expect((await db.query.entitlements.findMany()).length).toBe(1)
  })
})
