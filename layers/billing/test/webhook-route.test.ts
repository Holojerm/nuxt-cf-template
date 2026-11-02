// POST /paddle/webhook, driven as a function against a real D1 inside workerd.
//
// The route is a Nitro handler that leans on auto-imports, which do not exist
// under vitest, so each is stubbed as the global it would resolve to — with the
// REAL implementation wherever there is one (the signature check, the schema,
// applyPaddleEvent, the ops spool). Only the edges are fakes: the request, the
// runtime config, email and PostHog. What this pins is the contract the replay
// script (test/replay/) checks end to end against a built Worker: the status
// codes, and which deliveries raise an ops alert and which are only a log line.

import { env } from 'cloudflare:test'
import { createError } from 'h3'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { pathForLog } from '~~/server/utils/log'
import { recordOpsEvent } from '~~/server/utils/ops'
import { paddleSubscriptionEvent } from '#shared/utils/analytics-events'
import {
  clearBillingOutcomeHandlersForTest,
  registerBillingOutcomeHandler,
  runBillingOutcomeHandlers,
} from '../server/utils/billing-outcome'
import {
  adjustmentMatchedNothing,
  applyPaddleEvent,
  paddleEventSchema,
} from '../server/utils/entitlements'
import { verifyPaddleSignature } from '../server/utils/paddle'
import { isForeignProduct, paddlePriceCatalogue } from '../server/utils/paddle-prices'

const db = drizzle(env.DB, { schema })
const SECRET = 'whsec_route_test'
const USER = 'user-route'
const PRICE_PASS = 'pri_route_pass'
const PRICE_MONTHLY = 'pri_route_monthly'
const OWN_PRODUCT = 'pro_route_own'

interface Config {
  paddle: { webhookSecret: string; productId: string }
  billing: { alertUnmatchedAdjustments: boolean }
  public: { paddlePricePass: string; paddlePriceMonthly: string }
}

let config: Config
let raw: string | undefined
let header: string | undefined
let captured: { event: string }[]
let logs: Record<'warn' | 'info' | 'error', ReturnType<typeof vi.spyOn>>
let eventSeq = 0

type Handler = (event: unknown) => Promise<{ received: boolean }>
let handler: Handler

beforeEach(async () => {
  eventSeq = 0
  captured = []
  config = {
    paddle: { webhookSecret: SECRET, productId: '' },
    billing: { alertUnmatchedAdjustments: true },
    public: { paddlePricePass: PRICE_PASS, paddlePriceMonthly: PRICE_MONTHLY },
  }
  await env.DB.exec('DELETE FROM ops_events')
  await env.DB.exec('DELETE FROM paddle_events')
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
  vi.stubGlobal('pathForLog', pathForLog)
  vi.stubGlobal('verifyPaddleSignature', verifyPaddleSignature)
  vi.stubGlobal('paddleEventSchema', paddleEventSchema)
  vi.stubGlobal('applyPaddleEvent', applyPaddleEvent)
  vi.stubGlobal('paddlePriceCatalogue', paddlePriceCatalogue)
  vi.stubGlobal('isForeignProduct', isForeignProduct)
  vi.stubGlobal('adjustmentMatchedNothing', adjustmentMatchedNothing)
  vi.stubGlobal('runBillingOutcomeHandlers', runBillingOutcomeHandlers)
  vi.stubGlobal('paddleSubscriptionEvent', paddleSubscriptionEvent)
  vi.stubGlobal('notifyBillingOutcome', async () => {})
  vi.stubGlobal('captureServerEvent', async (e: { event: string }) => void captured.push(e))
  logs = {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  }

  vi.resetModules()
  handler = (await import('../server/routes/paddle/webhook.post')).default as unknown as Handler
})

afterEach(() => {
  clearBillingOutcomeHandlersForTest()
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
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${body}`))
  const h1 = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')
  return `ts=${ts};h1=${h1}`
}

/** Deliver `body` signed (or not) and report the status the route answers with. */
async function deliver(body: string, opts: { secret?: string; age?: number } = {}) {
  raw = body
  header = await sign(body, opts.secret, opts.age)
  try {
    const result = await handler({ path: '/paddle/webhook' })
    return { status: 200, result }
  } catch (error) {
    return { status: (error as { statusCode: number }).statusCode }
  }
}

function paddleEvent(
  type: string,
  data: Record<string, unknown>,
  eventId = `evt_route_${++eventSeq}`,
) {
  return JSON.stringify({
    event_id: eventId,
    event_type: type,
    occurred_at: '2099-01-01T00:00:00Z',
    data,
  })
}

const purchase = (priceId: string, productId: string | null, userId: string | null = USER) =>
  paddleEvent('transaction.completed', {
    id: `txn_route_${++eventSeq}`,
    status: 'completed',
    custom_data: userId ? { userId } : null,
    items: [{ price: { id: priceId, product_id: productId } }],
    billed_at: '2099-01-01T00:00:00Z',
  })

async function opsKinds(): Promise<string[]> {
  const rows = await db.select().from(schema.opsEvents)
  return rows.map((row) => row.kind).sort()
}

describe('what the route refuses', () => {
  it('503s and alerts when the secret is unset', async () => {
    config.paddle.webhookSecret = ''
    expect((await deliver(purchase(PRICE_PASS, null))).status).toBe(503)
    expect(await opsKinds()).toEqual(['paddle_webhook_unconfigured'])
  })

  it('401s a wrong secret and a stale timestamp, each with an alert', async () => {
    expect((await deliver(purchase(PRICE_PASS, null), { secret: 'nope' })).status).toBe(401)
    expect((await deliver(purchase(PRICE_PASS, null), { age: 60 })).status).toBe(401)
    expect(await opsKinds()).toEqual(['paddle_webhook_rejected', 'paddle_webhook_rejected'])
  })

  it('400s a signed body that is not JSON (not a 500) and one that is not a Paddle event', async () => {
    expect((await deliver('{ definitely not json')).status).toBe(400)
    expect((await deliver(JSON.stringify({ hello: 'world' }))).status).toBe(400)
    expect(await opsKinds()).toEqual(['paddle_webhook_unparseable', 'paddle_webhook_unparseable'])
  })

  it('400s a body that is JSON null', async () => {
    expect((await deliver('null')).status).toBe(400)
  })
})

describe('what it acknowledges but flags', () => {
  it('grants a configured pass: 200, no alert', async () => {
    expect((await deliver(purchase(PRICE_PASS, OWN_PRODUCT))).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(await db.select().from(schema.entitlements)).toHaveLength(1)
  })

  it('alerts on an unrecognised price and grants nothing', async () => {
    expect((await deliver(purchase('pri_unlisted', OWN_PRODUCT))).status).toBe(200)
    expect(await opsKinds()).toEqual(['paddle_webhook_unrecognised_price'])
    expect(await db.select().from(schema.entitlements)).toHaveLength(0)
  })

  it('alerts on an unknown user, and on an event with no user at all', async () => {
    expect((await deliver(purchase(PRICE_PASS, null, 'user-ghost'))).status).toBe(200)
    expect((await deliver(purchase(PRICE_PASS, null, null))).status).toBe(200)
    expect(await opsKinds()).toEqual(['paddle_webhook_no_user', 'paddle_webhook_unknown_user'])
  })

  it('does not alert on duplicates or out-of-order events (expected traffic)', async () => {
    const body = purchase(PRICE_PASS, null)
    await deliver(body)
    expect((await deliver(body)).status).toBe(200)
    expect(await opsKinds()).toEqual([])
  })
})

describe('a shared Paddle account (NUXT_PADDLE_PRODUCT_ID)', () => {
  it('without a product id configured, another product’s sale is an unrecognised price', async () => {
    await deliver(purchase('pri_other', 'pro_other'))
    expect(await opsKinds()).toEqual(['paddle_webhook_unrecognised_price'])
  })

  it('with one, a sale on another product is an info log and no alert', async () => {
    config.paddle.productId = OWN_PRODUCT
    expect((await deliver(purchase('pri_other', 'pro_other'))).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(logs.info).toHaveBeenCalledWith(
      expect.stringContaining('paddle_webhook_foreign_product'),
    )
  })

  it('with one, an unlisted price on OUR product still alerts', async () => {
    config.paddle.productId = OWN_PRODUCT
    await deliver(purchase('pri_unlisted', OWN_PRODUCT))
    expect(await opsKinds()).toEqual(['paddle_webhook_unrecognised_price'])
  })

  it('with one, a basket mixing ours and another product still alerts', async () => {
    config.paddle.productId = OWN_PRODUCT
    await deliver(
      paddleEvent('transaction.completed', {
        id: 'txn_mixed',
        custom_data: { userId: USER },
        items: [
          { price: { id: 'pri_other', product_id: 'pro_other' } },
          { price: { id: 'pri_unlisted', product_id: OWN_PRODUCT } },
        ],
      }),
    )
    expect(await opsKinds()).toEqual(['paddle_webhook_unrecognised_price'])
  })
})

describe('refunds that match nothing', () => {
  const refund = () =>
    paddleEvent('adjustment.created', {
      id: `adj_${++eventSeq}`,
      action: 'refund',
      type: 'full',
      status: 'approved',
      transaction_id: 'txn_nobody',
    })

  it('alert by default', async () => {
    expect((await deliver(refund())).status).toBe(200)
    expect(await opsKinds()).toEqual(['paddle_adjustment_unmatched'])
  })

  it('stay a log line when billing.alertUnmatchedAdjustments is off', async () => {
    config.billing.alertUnmatchedAdjustments = false
    expect((await deliver(refund())).status).toBe(200)
    expect(await opsKinds()).toEqual([])
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('"kind":"paddle_adjustment"'))
  })

  it('do not alert when the refund names a transaction we granted', async () => {
    const body = purchase(PRICE_PASS, OWN_PRODUCT)
    await deliver(body)
    const ref = (JSON.parse(body) as { data: { id: string } }).data.id
    await deliver(
      paddleEvent('adjustment.created', {
        id: 'adj_matched',
        action: 'refund',
        type: 'full',
        status: 'approved',
        transaction_id: ref,
      }),
    )
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
    expect(captured.map((c) => c.event)).toEqual(['paddle_transaction_completed'])
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
