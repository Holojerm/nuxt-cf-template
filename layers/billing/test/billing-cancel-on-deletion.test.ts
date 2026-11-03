// `billing.cancelOnDeletion`: deleting an account first cancels every live
// Paddle subscription, immediately, and refuses (409, the guard's code) if any
// cancel fails. Real D1 inside workerd, real Paddle client; only the network
// edge is faked (global fetch) and the runtime config the client reads.

import { env } from 'cloudflare:test'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount } from '~~/server/utils/account'
import {
  clearExtensionsForTest,
  getDeletionGuards,
  getDeletionResolvers,
} from '~~/server/utils/extensions'
import { registerBillingExtensions } from '../server/utils/billing-extensions'
import { clearEntitlementViewFieldsForTest } from '~~/server/utils/entitlement-view-fields'
import { buildEntitlementView } from '../server/utils/entitlement-view'
import { notifyBillingOutcome } from '../server/utils/billing-notifications'
import { clearBillingOutcomeHandlersForTest } from '~~/server/utils/billing-outcome'
import { clearUnknownUserExpectationsForTest } from '../server/utils/billing-expectations'

const db = drizzle(env.DB, { schema })
const USER = 'user-cancel'
const KEY = 'pdl_sdbx_apikey_super_secret'
const FUTURE = new Date(Date.now() + 86_400_000)

interface PaddleCall {
  url: string
  method: string
  authorization: string | null
  body: unknown
}

let calls: PaddleCall[]
let errorLog: ReturnType<typeof vi.spyOn>
let config: { paddle: { apiKey: string; apiBase: string }; public: { paddleEnv: string } }
/** Per subscription id: how the fake Paddle answers. Default: 200. */
let answers: Record<string, () => Response | Promise<Response>>

const paddleError = (status: number, code: string, detail = 'customer@example.com leaked?') =>
  new Response(JSON.stringify({ error: { code, detail } }), { status })

beforeEach(async () => {
  calls = []
  answers = {}
  config = { paddle: { apiKey: KEY, apiBase: '' }, public: { paddleEnv: 'sandbox' } }
  vi.stubGlobal('useRuntimeConfig', () => config)
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: JSON.parse(String(init.body)),
    })
    const id = decodeURIComponent(url.split('/subscriptions/')[1]!.split('/')[0]!)
    return await (answers[id] ?? (() => new Response('{}', { status: 200 })))()
  })
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

  clearExtensionsForTest()
  clearEntitlementViewFieldsForTest()
  clearBillingOutcomeHandlersForTest()
  clearUnknownUserExpectationsForTest()
  await env.DB.exec('DELETE FROM ops_events')
  await db.delete(schema.auditLog)
  await db.delete(schema.entitlements)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'cancel@example.com', name: 'Cass' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearExtensionsForTest()
  clearEntitlementViewFieldsForTest()
  clearBillingOutcomeHandlersForTest()
  clearUnknownUserExpectationsForTest()
})

async function entitle(ref: string, status = 'active', extra: Record<string, unknown> = {}) {
  await db.insert(schema.entitlements).values({
    userId: USER,
    paddleSubscriptionId: ref,
    status,
    currentPeriodEnd: FUTURE,
    ...extra,
  })
}

const userRow = () => db.query.users.findFirst({ where: eq(schema.users.id, USER) })
const auditActions = async () =>
  (await db.query.auditLog.findMany({ orderBy: sql`rowid` })).map((r) => r.action)
const opsRows = () => db.select().from(schema.opsEvents)

describe('option on: cancel, then delete', () => {
  beforeEach(() => registerBillingExtensions({ cancelOnDeletion: true }))

  it('cancels a live subscription immediately through the Paddle API, then deletes', async () => {
    await entitle('sub_live1')

    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })

    expect(calls).toEqual([
      {
        url: 'https://sandbox-api.paddle.com/subscriptions/sub_live1/cancel',
        method: 'POST',
        authorization: `Bearer ${KEY}`,
        body: { effective_from: 'immediately' },
      },
    ])
    expect((await userRow())?.email).toBe(`deleted-${USER}@deleted.invalid`)
    // Billing history is retained, as with the guard.
    expect(await db.query.entitlements.findMany()).toHaveLength(1)
  })

  it('uses the production host for a production deployment, and an API base override', async () => {
    await entitle('sub_prod')
    config.public.paddleEnv = 'production'
    await deleteAccount(db, USER)
    expect(calls[0]?.url).toBe('https://api.paddle.com/subscriptions/sub_prod/cancel')

    await db.update(schema.users).set({ email: 'cancel@example.com' })
    await db.update(schema.entitlements).set({ status: 'active' })
    config.paddle.apiBase = 'http://127.0.0.1:9999/'
    await deleteAccount(db, USER)
    expect(calls[1]?.url).toBe('http://127.0.0.1:9999/subscriptions/sub_prod/cancel')
  })

  it('audits before the call, with subscription ids only, ahead of account.deleted', async () => {
    await entitle('sub_audit')
    answers.sub_audit = async () => {
      // The intent row must already be there when Paddle is called.
      expect(await auditActions()).toEqual(['account.subscription_cancel_requested'])
      return new Response('{}', { status: 200 })
    }

    await deleteAccount(db, USER)

    expect(await auditActions()).toEqual([
      'account.subscription_cancel_requested',
      'account.deleted',
    ])
    const [row] = await db.query.auditLog.findMany({
      where: eq(schema.auditLog.action, 'account.subscription_cancel_requested'),
    })
    expect(row).toMatchObject({
      actorUserId: USER,
      actorType: 'user',
      targetId: USER,
      metadata: { subscriptionId: 'sub_audit' },
    })
  })

  it('cancels every live subscription, across product keys, and only the live ones', async () => {
    await entitle('sub_a')
    await entitle('sub_b', 'trialing', { productKey: 'addon' })
    await entitle('sub_c', 'past_due')
    await entitle('sub_d', 'paused')
    // Not live: terminal, cancel already scheduled, a pass, a comp.
    await entitle('sub_dead', 'canceled')
    await entitle('sub_scheduled', 'active', { scheduledChangeAction: 'cancel' })
    await entitle('txn_pass')
    await entitle('comp_gift')

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    expect(calls.map((c) => c.url.split('/subscriptions/')[1]).sort()).toEqual([
      'sub_a/cancel',
      'sub_b/cancel',
      'sub_c/cancel',
      'sub_d/cancel',
    ])
  })

  it('does not call Paddle for a pass holder, and deletes as before', async () => {
    await entitle('txn_pass')
    await entitle('comp_gift')

    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })

    expect(calls).toEqual([])
    expect(await auditActions()).toEqual(['account.deleted'])
  })

  it.each([['subscription_is_canceled_action_invalid'], ['subscription_update_when_canceled']])(
    'treats Paddle’s %s as success: it is final, so deletion goes on',
    async (code) => {
      await entitle('sub_gone')
      answers.sub_gone = () => paddleError(400, code)

      expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
      expect(await opsRows()).toEqual([])
    },
  )

  it.each([
    [
      'a missing subscription.write permission (403)',
      () => paddleError(403, 'forbidden'),
      '403',
      'forbidden',
    ],
    ['a server error (500)', () => paddleError(500, 'internal_error'), '500', 'internal_error'],
    ['an unrelated 400', () => paddleError(400, 'invalid_field'), '400', 'invalid_field'],
    [
      'a non-JSON gateway page (502)',
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      '502',
      'none',
    ],
    [
      'a network failure',
      () => Promise.reject(new TypeError('connect failed')),
      '0',
      'network_error',
    ],
  ])('fails closed on %s: 409 material, nothing deleted', async (_name, answer, status, code) => {
    await entitle('sub_stuck')
    answers.sub_stuck = answer as never

    const outcome = await deleteAccount(db, USER)

    expect(outcome).toEqual({
      outcome: 'blocked',
      code: 'live_subscription',
      message: expect.stringContaining('billing portal'),
      data: { subscriptionId: 'sub_stuck' },
    })
    // Untouched: not anonymised, no account.deleted row.
    expect((await userRow())?.email).toBe('cancel@example.com')
    expect(await auditActions()).toEqual(['account.subscription_cancel_requested'])

    // One ops event: the id and Paddle's status and code, and nothing else.
    const [event] = await opsRows()
    expect(await opsRows()).toHaveLength(1)
    expect(event).toMatchObject({
      kind: 'deletion_cancel_failed',
      detail: `sub_stuck: Paddle status ${status}, code ${code} — account deletion refused, nothing deleted`,
    })
    const everything = JSON.stringify([event, errorLog.mock.calls])
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain('cancel@example.com')
    expect(everything).not.toContain('leaked')
  })

  it('refuses when no API key is configured, rather than skipping the cancel', async () => {
    await entitle('sub_nokey')
    config.paddle.apiKey = ''

    expect(await deleteAccount(db, USER)).toMatchObject({
      outcome: 'blocked',
      code: 'live_subscription',
    })
    expect(calls).toEqual([])
    expect((await opsRows())[0]?.detail).toContain('Paddle status 0, code unconfigured')
  })

  it('stops at the first failure, leaves the rest uncalled, and the account intact', async () => {
    await entitle('sub_1')
    await entitle('sub_2')
    const [first] = await db.select().from(schema.entitlements)
    answers[first!.paddleSubscriptionId] = () => paddleError(403, 'forbidden')

    expect((await deleteAccount(db, USER)).outcome).toBe('blocked')

    expect(calls).toHaveLength(1)
    expect((await userRow())?.email).toBe('cancel@example.com')
  })

  it('can be retried: a second attempt after a failure cancels and deletes', async () => {
    await entitle('sub_retry')
    answers.sub_retry = () => paddleError(500, 'internal_error')
    expect((await deleteAccount(db, USER)).outcome).toBe('blocked')

    delete answers.sub_retry
    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
  })

  it('leaves the guard to the resolver: it registers no DeletionGuard, whatever guardDeletion says', () => {
    expect(getDeletionGuards()).toEqual([])
    expect(getDeletionResolvers().map((r) => r.key)).toEqual(['billing'])

    clearExtensionsForTest()
    registerBillingExtensions({ cancelOnDeletion: true, guardDeletion: true })
    expect(getDeletionGuards()).toEqual([])
    expect(getDeletionResolvers()).toHaveLength(1)
  })
})

describe('deletionRefusalCode', () => {
  it('is the code of a failed cancel', async () => {
    registerBillingExtensions({ cancelOnDeletion: true, deletionRefusalCode: 'billing_live' })
    await entitle('sub_code')
    answers.sub_code = () => paddleError(403, 'forbidden')

    expect(await deleteAccount(db, USER)).toMatchObject({
      outcome: 'blocked',
      code: 'billing_live',
      data: { subscriptionId: 'sub_code' },
    })
  })

  it('is the code of the guard too, with the option off', async () => {
    registerBillingExtensions({ deletionRefusalCode: 'billing_live' })
    await entitle('sub_guarded')

    expect(await deleteAccount(db, USER)).toMatchObject({
      outcome: 'blocked',
      code: 'billing_live',
      data: { subscriptionId: 'sub_guarded' },
    })
    expect(calls).toEqual([])
  })

  it('defaults to live_subscription, and an empty string is the default', async () => {
    registerBillingExtensions({ deletionRefusalCode: '' })
    await entitle('sub_default')
    expect(await deleteAccount(db, USER)).toMatchObject({ code: 'live_subscription' })
  })
})

describe('option off (the default): exactly the guard, as before', () => {
  it.each([
    [{}],
    [{ cancelOnDeletion: false }],
    [{ guardDeletion: true, cancelOnDeletion: false }],
  ])('refuses a live subscription and never calls Paddle (%j)', async (options) => {
    registerBillingExtensions(options)
    expect(getDeletionResolvers()).toEqual([])
    expect(getDeletionGuards().map((g) => g.key)).toEqual(['billing'])
    await entitle('sub_off')

    expect(await deleteAccount(db, USER)).toEqual({
      outcome: 'blocked',
      code: 'live_subscription',
      message: expect.stringContaining('Cancel it from the billing portal first'),
      data: { subscriptionId: 'sub_off' },
    })
    expect(calls).toEqual([])
    expect(await auditActions()).toEqual([])
    expect(await opsRows()).toEqual([])
  })

  it('with guardDeletion: false registers neither', () => {
    registerBillingExtensions({ guardDeletion: false })
    expect(getDeletionGuards()).toEqual([])
    expect(getDeletionResolvers()).toEqual([])
  })

  it('adds no field to the billing view', async () => {
    registerBillingExtensions()
    expect(await buildEntitlementView(db, USER)).not.toHaveProperty('cancelsOnDeletion')
  })
})

describe('the billing view', () => {
  it('says the page can promise a cancel, only with the option on', async () => {
    registerBillingExtensions({ cancelOnDeletion: true })
    expect(await buildEntitlementView(db, USER)).toMatchObject({ cancelsOnDeletion: true })
  })
})

describe('the echo of our own cancel', () => {
  // The echo names a user whose row is now a tombstone: the notice must not go
  // to the `.invalid` address, and only when the option asked for that.
  const sent: { to: string }[] = []
  const outcome = {
    kind: 'subscription' as const,
    userId: USER,
    status: 'canceled',
    previousStatus: 'active',
    firstTransactionId: null,
  }

  beforeEach(async () => {
    sent.length = 0
    await db.update(schema.users).set({ email: `deleted-${USER}@deleted.invalid` })
    vi.stubGlobal('sendEmail', async (mail: { to: string }) => void sent.push(mail))
    vi.stubGlobal('emailBranding', () => ({}))
    vi.stubGlobal('accessEndedEmail', () => ({ subject: 'ended', html: '', text: '' }))
    vi.stubGlobal('findUserById', async () => userRow())
  })

  it('is not emailed to the tombstone address with the option on', async () => {
    registerBillingExtensions({ cancelOnDeletion: true })
    await notifyBillingOutcome(db, outcome)
    expect(sent).toEqual([])
  })

  it('is attempted as before with the option off', async () => {
    registerBillingExtensions()
    await notifyBillingOutcome(db, outcome)
    expect(sent).toEqual([
      { to: `deleted-${USER}@deleted.invalid`, subject: 'ended', html: '', text: '' },
    ])
  })

  it('still emails a real address with the option on', async () => {
    registerBillingExtensions({ cancelOnDeletion: true })
    await db.update(schema.users).set({ email: 'real@example.com' })
    await notifyBillingOutcome(db, outcome)
    expect(sent).toHaveLength(1)
  })
})
