// The money rules, run against a real D1 inside workerd.
//
// Everything here goes through applyBillingEvent — the same function the webhook
// route calls after verifying the signature — so a passing suite means the
// actual purchase, stacking, and refund paths behave, not just their parts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { eq } from 'drizzle-orm'
import { priceCatalogue } from '../server/utils/stripe-prices'
import {
  applyBillingEvent as applyBillingEventWith,
  findActiveEntitlement,
  getBillingOverview,
  isBillingLive,
  billingEventSchema,
  type BillingEvent,
} from '../server/utils/entitlements'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const USER = 'user-1'

/** The prices this "deployment" sells — what the webhook checks every purchase against. */
const PRICES = { monthly: 'price_monthly', pass: 'price_pass' } as const
const CATALOGUE = priceCatalogue({
  stripePriceMonthly: PRICES.monthly,
  stripePricePass: PRICES.pass,
})
const SUBSCRIPTION_ITEMS = [{ price: { id: PRICES.monthly } }]
const PASS_ITEMS = [{ price: { id: PRICES.pass } }]

/** Every existing case buys something this deployment sells; the catalogue cases below pass their own. */
function applyBillingEvent(d: typeof db, event: BillingEvent, catalogue = CATALOGUE) {
  return applyBillingEventWith(d, event, catalogue)
}

/** D1 timestamp columns are epoch seconds — expectations round the same way. */
function atSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

async function makeUser(id = USER) {
  await db
    .insert(schema.users)
    .values({ id, email: `${id}@example.com`, name: id })
    .onConflictDoNothing()
}

/** Build + validate an event exactly as the webhook route would parse it. */
function billingEvent(
  eventType: string,
  data: Record<string, unknown>,
  meta: { eventId?: string; occurredAt?: Date } = {},
): BillingEvent {
  // Items default to the kind the event type implies, so a case about
  // stacking or refunds does not have to restate what was bought.
  const items = eventType.startsWith('subscription.') ? SUBSCRIPTION_ITEMS : PASS_ITEMS
  return billingEventSchema.parse({
    event_id: meta.eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
    event_type: eventType,
    // Defaults to "now" so a sequence built in order is delivered in order.
    occurred_at: (meta.occurredAt ?? new Date()).toISOString(),
    data: { items, ...data },
  })
}

/** Pass purchases report the same occurred_at, so a case can build an adjustment that predates it. */
const passPurchaseOccurredAt = new Date(Date.now() - 60 * 60 * 1000)

function passPurchase(transactionId: string, billedAt: Date, userId = USER) {
  return billingEvent(
    'transaction.completed',
    {
      id: transactionId,
      status: 'completed',
      customer_id: 'cus_1',
      billed_at: billedAt.toISOString(),
      custom_data: { userId, productKey: 'default' },
    },
    { occurredAt: passPurchaseOccurredAt },
  )
}

function refund(opts: {
  transactionId?: string
  subscriptionId?: string
  action?: string
  status?: string
  type?: string
  eventType?: string
}) {
  return billingEvent(opts.eventType ?? 'adjustment.created', {
    id: 'adj_1',
    action: opts.action ?? 'refund',
    type: opts.type ?? 'full',
    status: opts.status ?? 'approved',
    transaction_id: opts.transactionId ?? null,
    subscription_id: opts.subscriptionId ?? null,
    customer_id: 'cus_1',
  })
}

beforeEach(async () => {
  await db.delete(schema.entitlements)
  await db.delete(schema.billingEvents)
  await makeUser()
})

describe('one-time pass', () => {
  it('grants 30 days from the billing date', async () => {
    // Relative, not a literal date: `findActiveEntitlement` compares the window
    // against the wall clock, so a fixed `billedAt` turns into a failing test
    // thirty days after it was written.
    const billedAt = new Date(Date.now() - 2 * DAY_MS)
    const outcome = await applyBillingEvent(db, passPurchase('pi_1', billedAt))

    expect(outcome).toMatchObject({ kind: 'pass', granted: true, stackedOn: null })
    const active = await findActiveEntitlement(db, USER)
    expect(active?.status).toBe('active')
    expect(active?.currentPeriodEnd?.getTime()).toBe(atSecond(billedAt.getTime() + 30 * DAY_MS))
    // Both ends of the window are stored: the clawback measures from the start.
    expect(active?.periodStart?.getTime()).toBe(atSecond(billedAt.getTime()))
  })

  it('acknowledges a purchase whose custom_data names no account', async () => {
    // A 500 here would have Stripe retry forever; the FK failure is the signal.
    const outcome = await applyBillingEvent(db, passPurchase('pi_1', new Date(), 'nobody'))
    expect(outcome).toEqual({ kind: 'ignored', reason: 'unknown_user' })
    expect(await db.query.entitlements.findMany()).toHaveLength(0)
    expect(await db.query.billingEvents.findMany()).toHaveLength(0)
  })

  it('is idempotent across webhook redelivery', async () => {
    const billedAt = new Date(Date.now() - DAY_MS)
    const first = await applyBillingEvent(db, passPurchase('pi_1', billedAt))
    const redelivered = await applyBillingEvent(db, passPurchase('pi_1', billedAt))

    expect(first).toMatchObject({ kind: 'pass', granted: true })
    expect(redelivered).toMatchObject({ kind: 'pass', granted: false })
    if (first.kind !== 'pass' || redelivered.kind !== 'pass') throw new Error('wrong kind')
    // Same window, not 30 more days.
    expect(redelivered.endsAt.getTime()).toBe(first.endsAt.getTime())
    const rows = await db.query.entitlements.findMany()
    expect(rows).toHaveLength(1)
  })

  it('ignores a transaction with no userId in custom_data', async () => {
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', { id: 'pi_x', status: 'completed' }),
    )
    expect(outcome).toEqual({ kind: 'ignored', reason: 'no_user' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('ignores a transaction that belongs to a subscription (renewal)', async () => {
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_renewal',
        subscription_id: 'sub_1',
        custom_data: { userId: USER },
      }),
    )
    expect(outcome).toEqual({ kind: 'ignored', reason: 'subscription_transaction' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('expires once the window passes', async () => {
    await applyBillingEvent(db, passPurchase('pi_old', new Date(Date.now() - 40 * DAY_MS)))
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })
})

describe('stacking passes', () => {
  it('extends from the current expiry, not from the purchase date', async () => {
    const first = new Date(Date.now() - 10 * DAY_MS)
    const firstResult = await applyBillingEvent(db, passPurchase('pi_1', first))
    if (firstResult.kind !== 'pass') throw new Error('wrong kind')

    const second = await applyBillingEvent(db, passPurchase('pi_2', new Date()))
    if (second.kind !== 'pass') throw new Error('wrong kind')

    expect(second.stackedOn?.getTime()).toBe(firstResult.endsAt.getTime())
    expect(second.endsAt.getTime()).toBe(firstResult.endsAt.getTime() + 30 * DAY_MS)
    // The user now has ~50 days of runway, from two separate rows.
    const active = await findActiveEntitlement(db, USER)
    expect(active?.billingRef).toBe('pi_2')
    // The stacked pass OPENS where the first one closes — the window it was
    // granted, not the moment it was bought.
    expect(active?.periodStart?.getTime()).toBe(firstResult.endsAt.getTime())
  })

  it('starts fresh when the previous pass has already lapsed', async () => {
    await applyBillingEvent(db, passPurchase('pi_1', new Date(Date.now() - 60 * DAY_MS)))
    const billedAt = new Date()
    const second = await applyBillingEvent(db, passPurchase('pi_2', billedAt))

    expect(second).toMatchObject({ kind: 'pass', stackedOn: null })
    if (second.kind !== 'pass') throw new Error('wrong kind')
    // Whole seconds: that's the resolution D1 stores timestamps at.
    expect(second.endsAt.getTime()).toBe(atSecond(billedAt.getTime() + 30 * DAY_MS))
  })

  it('extends past a running subscription rather than shortening it', async () => {
    const renewsAt = new Date(Date.now() + 20 * DAY_MS)
    await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: renewsAt.toISOString() },
      }),
    )
    const pass = await applyBillingEvent(db, passPurchase('pi_1', new Date()))
    if (pass.kind !== 'pass') throw new Error('wrong kind')
    expect(pass.endsAt.getTime()).toBe(atSecond(renewsAt.getTime() + 30 * DAY_MS))
  })
})

describe('subscriptions', () => {
  it('grants access and follows the status lifecycle', async () => {
    const endsAt = new Date(Date.now() + 20 * DAY_MS)
    await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
    )
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()

    await applyBillingEvent(
      db,
      billingEvent('subscription.canceled', {
        id: 'sub_1',
        status: 'canceled',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const rows = await db.query.entitlements.findMany()
    expect(rows).toHaveLength(1) // upsert, not a second row
  })
})

describe('refunds and chargebacks', () => {
  async function activePass(transactionId = 'pi_1') {
    await applyBillingEvent(db, passPurchase(transactionId, new Date()))
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  }

  it('revokes access when a refund is approved', async () => {
    await activePass()
    const outcome = await applyBillingEvent(db, refund({ transactionId: 'pi_1' }))

    expect(outcome).toMatchObject({
      kind: 'adjustment',
      action: 'refund',
      result: { outcome: 'revoked', userId: USER, billingRef: 'pi_1' },
    })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('refunded')
    // The window is closed too, so the MCP worker's date-based SQL gate agrees.
    expect(row?.currentPeriodEnd!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('waits for approval before revoking a pending refund', async () => {
    await activePass()
    const outcome = await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', status: 'pending_approval' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'status_not_final' } })
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('revokes on the adjustment.updated that approves it', async () => {
    await activePass()
    await applyBillingEvent(db, refund({ transactionId: 'pi_1', status: 'pending_approval' }))
    await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', status: 'approved', eventType: 'adjustment.updated' }),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('leaves access alone when a refund is rejected', async () => {
    await activePass()
    await applyBillingEvent(db, refund({ transactionId: 'pi_1', status: 'rejected' }))
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('revokes a partial refund too — the stated policy', async () => {
    await activePass()
    await applyBillingEvent(db, refund({ transactionId: 'pi_1', type: 'partial' }))
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('revokes immediately on a chargeback, before Stripe approves it', async () => {
    await activePass()
    await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', action: 'chargeback', status: 'pending_approval' }),
    )
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('chargeback')
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('gives a pass back when the customer WINS the chargeback', async () => {
    // No `subscription.*` event ever arrives for a `pi_` pass, so nothing else
    // in the system would ever notice the dispute resolved — a customer who won
    // simply lost 30 paid days, forever, and no later Stripe event repaired it.
    await activePass()
    const paidUntil = (await findActiveEntitlement(db, USER))!.currentPeriodEnd!.getTime()

    await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', action: 'chargeback', status: 'pending_approval' }),
    )
    // Stripe redelivers. The second write must not stamp `now` over the window
    // the first one recorded, or the row becomes unrestorable.
    await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', action: 'chargeback', status: 'pending_approval' }),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    const outcome = await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', action: 'chargeback', status: 'reversed' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'reversed', billingRef: 'pi_1' } })
    // Not a revoke, so the route's `billing_access_revoked` capture stays quiet.
    if (outcome.kind !== 'adjustment') throw new Error('wrong kind')
    expect(outcome.result.userId).toBeUndefined()

    const row = await findActiveEntitlement(db, USER)
    expect(row?.status).toBe('active')
    // The window they paid for, not a fresh one from today.
    expect(row?.currentPeriodEnd?.getTime()).toBe(paidUntil)
    expect(row?.restorePeriodEnd).toBeNull()
  })

  it('does NOT give a pass back when the money was refunded, whatever arrives later', async () => {
    // `refunded` is written by us, never by Stripe's lifecycle: the money went
    // back and stayed back, and a stray reversal on that transaction is not a
    // dispute we won.
    await activePass()
    await applyBillingEvent(db, refund({ transactionId: 'pi_1' }))

    const outcome = await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_1', action: 'chargeback_reverse' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'reversed' } })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('refunded')
  })

  it('ignores credits and chargeback warnings', async () => {
    await activePass()
    for (const action of ['credit', 'chargeback_warning', 'credit_reverse']) {
      const outcome = await applyBillingEvent(db, refund({ transactionId: 'pi_1', action }))
      expect(outcome).toMatchObject({ result: { outcome: 'action_not_revoking' } })
    }
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('matches a subscription refund by subscription id', async () => {
    await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: new Date(Date.now() + 20 * DAY_MS).toISOString() },
      }),
    )
    // A renewal's refund names an invoice we never stored, plus
    // the subscription id, which we did.
    const outcome = await applyBillingEvent(
      db,
      refund({ transactionId: 'pi_unknown', subscriptionId: 'sub_1' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'revoked', billingRef: 'sub_1' } })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('only revokes the refunded pass, leaving a stacked one alone', async () => {
    await applyBillingEvent(db, passPurchase('pi_1', new Date()))
    await applyBillingEvent(db, passPurchase('pi_2', new Date()))
    await applyBillingEvent(db, refund({ transactionId: 'pi_2' }))

    const active = await findActiveEntitlement(db, USER)
    expect(active?.billingRef).toBe('pi_1')
  })

  it('acknowledges a refund with no matching entitlement', async () => {
    const outcome = await applyBillingEvent(db, refund({ transactionId: 'pi_nope' }))
    expect(outcome).toMatchObject({ result: { outcome: 'no_matching_entitlement' } })
  })
})

describe('event ordering and redelivery', () => {
  // Stripe documents out-of-order delivery. `occurred_at` is the ordering key,
  // `event_id` the dedup key, and adjustments alone may set or clear a
  // refunded/chargeback status.
  const T0 = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const later = (hours: number) => new Date(T0.getTime() + hours * 60 * 60 * 1000)

  function subscription(eventType: string, status: string, occurredAt: Date, eventId?: string) {
    return billingEvent(
      eventType,
      {
        id: 'sub_1',
        status,
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: later(24 * 30).toISOString() },
      },
      { occurredAt, eventId },
    )
  }

  it('refuses a delayed active that arrives after the cancel it predates', async () => {
    await applyBillingEvent(db, subscription('subscription.created', 'active', later(0)))
    await applyBillingEvent(db, subscription('subscription.canceled', 'canceled', later(2)))
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    const stale = await applyBillingEvent(
      db,
      subscription('subscription.updated', 'active', later(1)),
    )

    expect(stale).toEqual({ kind: 'ignored', reason: 'stale_event' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('canceled')
    expect(row?.lastEventAt?.getTime()).toBe(atSecond(later(2).getTime()))
  })

  it('refuses a delayed past_due that arrives after the recovery it predates', async () => {
    await applyBillingEvent(db, subscription('subscription.created', 'active', later(0)))
    await applyBillingEvent(db, subscription('subscription.updated', 'active', later(2)))

    const stale = await applyBillingEvent(
      db,
      subscription('subscription.past_due', 'past_due', later(1)),
    )

    expect(stale).toEqual({ kind: 'ignored', reason: 'stale_event' })
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('never lets a routine update move a refunded subscription back to active', async () => {
    await applyBillingEvent(db, subscription('subscription.created', 'active', later(0)))
    const refunded = await applyBillingEvent(
      db,
      billingEvent(
        'adjustment.created',
        {
          id: 'adj_1',
          action: 'refund',
          type: 'full',
          status: 'approved',
          subscription_id: 'sub_1',
          customer_id: 'cus_1',
        },
        { occurredAt: later(1) },
      ),
    )
    expect(refunded).toMatchObject({ kind: 'adjustment', result: { outcome: 'revoked' } })

    // A card edit an hour later: Stripe sends the full entity, status active.
    const revived = await applyBillingEvent(
      db,
      subscription('subscription.updated', 'active', later(2)),
    )

    expect(revived).toEqual({ kind: 'ignored', reason: 'terminal_status' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    expect((await db.query.entitlements.findFirst())?.status).toBe('refunded')
  })

  it('refuses an adjustment older than the row', async () => {
    await applyBillingEvent(db, passPurchase('pi_1', later(0)))
    const row = await db.query.entitlements.findFirst()
    expect(row?.lastEventAt?.getTime()).toBe(atSecond(passPurchaseOccurredAt.getTime()))

    const stale = await applyBillingEvent(
      db,
      billingEvent(
        'adjustment.created',
        {
          id: 'adj_1',
          action: 'refund',
          type: 'full',
          status: 'approved',
          transaction_id: 'pi_1',
          customer_id: 'cus_1',
        },
        { occurredAt: new Date(passPurchaseOccurredAt.getTime() - 60_000) },
      ),
    )

    expect(stale).toEqual({ kind: 'ignored', reason: 'stale_event' })
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('treats an exact redelivery (same event_id) as a no-op before any write', async () => {
    const created = subscription('subscription.created', 'active', later(0), 'evt_created')
    expect(await applyBillingEvent(db, created)).toMatchObject({ kind: 'subscription' })
    await applyBillingEvent(db, subscription('subscription.canceled', 'canceled', later(1)))

    // Same id, redelivered after the cancel: a naive "newer wins" would still
    // refuse it, but the point is that it never reaches the ordering guard.
    const redelivered = await applyBillingEvent(db, created)

    expect(redelivered).toEqual({ kind: 'ignored', reason: 'duplicate_event' })
    expect((await db.query.entitlements.findFirst())?.status).toBe('canceled')
    expect(await db.query.billingEvents.findMany()).toHaveLength(2)
  })

  it('records only events that wrote, so a replay of an ignored one still applies', async () => {
    const unknown = billingEvent(
      'transaction.completed',
      {
        id: 'pi_1',
        status: 'completed',
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        items: [{ price: { id: 'price_not_configured' } }],
      },
      { eventId: 'evt_replay' },
    )
    expect(await applyBillingEvent(db, unknown)).toMatchObject({ reason: 'unrecognised_price' })
    expect(await db.query.billingEvents.findMany()).toHaveLength(0)

    const replayed = await applyBillingEvent(
      db,
      unknown,
      priceCatalogue({ stripePricePass: 'price_not_configured' }),
    )
    expect(replayed).toMatchObject({ kind: 'pass', granted: true })
  })

  it('a redelivered pass purchase with a fresh event_id is still one pass', async () => {
    const billedAt = later(0)
    await applyBillingEvent(db, passPurchase('pi_1', billedAt))
    const again = await applyBillingEvent(db, passPurchase('pi_1', billedAt))
    expect(again).toMatchObject({ kind: 'pass', granted: false })
    expect(await db.query.entitlements.findMany()).toHaveLength(1)
  })
})

describe('subscription refunds are per period', () => {
  const T0 = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const later = (hours: number) => new Date(T0.getTime() + hours * 60 * 60 * 1000)
  const PERIOD_1 = later(24 * 30)
  const PERIOD_2 = later(24 * 60)

  function subscription(
    eventType: string,
    status: string,
    occurredAt: Date,
    extra: Record<string, unknown> = {},
  ) {
    return billingEvent(
      eventType,
      {
        id: 'sub_1',
        status,
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: PERIOD_1.toISOString() },
        ...extra,
      },
      { occurredAt },
    )
  }

  function adjustment(overrides: Record<string, unknown>, occurredAt: Date) {
    return billingEvent(
      'adjustment.created',
      {
        id: 'adj_1',
        action: 'refund',
        type: 'partial',
        status: 'approved',
        subscription_id: 'sub_1',
        customer_id: 'cus_1',
        ...overrides,
      },
      { occurredAt },
    )
  }

  it('remembers the transaction that created the subscription', async () => {
    const created = await applyBillingEvent(
      db,
      subscription('subscription.created', 'trialing', later(0), { transaction_id: 'pi_first' }),
    )
    expect(created).toMatchObject({ kind: 'subscription', firstTransactionId: 'pi_first' })

    // activated carries no transaction_id; the stored one stands.
    const activated = await applyBillingEvent(
      db,
      subscription('subscription.activated', 'active', later(1)),
    )
    expect(activated).toMatchObject({
      kind: 'subscription',
      previousStatus: 'trialing',
      firstTransactionId: 'pi_first',
    })
  })

  it('a refund of a renewal closes that period, and the next paid period reopens access', async () => {
    await applyBillingEvent(
      db,
      subscription('subscription.created', 'active', later(0), { transaction_id: 'pi_first' }),
    )
    const refunded = await applyBillingEvent(
      db,
      adjustment({ transaction_id: 'pi_renewal' }, later(1)),
    )
    expect(refunded).toMatchObject({ kind: 'adjustment', result: { outcome: 'revoked' } })
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    // A card edit re-sending the refunded period: still refused.
    const sameperiod = await applyBillingEvent(
      db,
      subscription('subscription.updated', 'active', later(2)),
    )
    expect(sameperiod).toEqual({ kind: 'ignored', reason: 'terminal_status' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    // Stripe bills the next period: the customer paid again.
    const renewed = await applyBillingEvent(
      db,
      subscription('subscription.updated', 'active', later(3), {
        current_billing_period: { ends_at: PERIOD_2.toISOString() },
      }),
    )
    expect(renewed).toMatchObject({ kind: 'subscription', previousStatus: 'refunded' })
    const row = await findActiveEntitlement(db, USER)
    expect(row?.currentPeriodEnd?.getTime()).toBe(atSecond(PERIOD_2.getTime()))
    expect(row?.restorePeriodEnd).toBeNull()
  })

  it('a won chargeback on a subscription gives the disputed period back', async () => {
    await applyBillingEvent(
      db,
      subscription('subscription.created', 'active', later(0), { transaction_id: 'pi_first' }),
    )
    await applyBillingEvent(
      db,
      adjustment({ action: 'chargeback', status: 'warning', transaction_id: 'pi_first' }, later(1)),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    const reversed = await applyBillingEvent(
      db,
      adjustment(
        {
          id: 'adj_2',
          action: 'chargeback_reverse',
          status: 'approved',
          transaction_id: 'pi_first',
        },
        later(2),
      ),
    )
    expect(reversed).toMatchObject({ kind: 'adjustment', result: { outcome: 'reversed' } })
    const row = await findActiveEntitlement(db, USER)
    expect(row?.currentPeriodEnd?.getTime()).toBe(atSecond(PERIOD_1.getTime()))
  })
})

describe('billing overview', () => {
  it('reports what can be cancelled and keeps ended rows in history', async () => {
    await applyBillingEvent(db, passPurchase('pi_old', new Date(Date.now() - 60 * DAY_MS)))
    await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        customer_id: 'cus_9',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: new Date(Date.now() + 10 * DAY_MS).toISOString() },
      }),
    )

    const overview = await getBillingOverview(db, USER)
    expect(overview.cancellableSubscriptionIds).toEqual(['sub_1'])
    expect(overview.providerCustomerId).toBe('cus_9')
    expect(overview.history).toHaveLength(2)
    expect(overview.active?.billingRef).toBe('sub_1')
  })

  it('has nothing to cancel for a pass-only customer', async () => {
    await applyBillingEvent(db, passPurchase('pi_1', new Date()))
    const overview = await getBillingOverview(db, USER)
    expect(overview.cancellableSubscriptionIds).toEqual([])
  })
})

// ── scheduled cancels ───────────────────────────────────────────────
// "Cancel at period end" does not change a subscription's status. Stripe keeps
// it `active` and shows it as `scheduled_change` on the event until the effective
// date, so a row that will never be billed again is indistinguishable from one
// that renews next month unless this is stored. Not storing it meant the
// deletion guard refused, for up to a year, to delete an account whose
// subscription was already cancelled — and told the customer to go cancel it.
//
// Payloads below use the layer's own event shape, because
// the field this is about is one `billingEventSchema` used to strip silently.

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    // Fresh id and timestamp per delivery: several cases send two updates in
    // a row, and a repeated event_id is now a deduplicated no-op.
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    event_type: 'subscription.updated',
    occurred_at: new Date().toISOString(),
    data: {
      id: 'sub_sched',
      status: 'active',
      customer_id: 'cus_1',
      custom_data: { userId: USER },
      items: SUBSCRIPTION_ITEMS,
      current_billing_period: { ends_at: '2026-09-01T00:00:00Z' },
      ...overrides,
    },
  }
}

describe('scheduled_change', () => {
  async function subscriptionRow() {
    return db.query.entitlements.findFirst({
      where: eq(schema.entitlements.billingRef, 'sub_sched'),
    })
  }

  it('stores a pending cancel with its effective date', async () => {
    await applyBillingEvent(
      db,
      billingEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row?.status).toBe('active')
    expect(row?.scheduledChangeAction).toBe('cancel')
    expect(row?.scheduledChangeAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('makes a pending cancel not billing-live, though its status still says active', async () => {
    await applyBillingEvent(
      db,
      billingEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row!.status).toBe('active')
    expect(isBillingLive(row!)).toBe(false)
  })

  it('CLEARS it when the event carries scheduled_change: null — the un-cancel case', async () => {
    // The case that makes `?? null` load-bearing rather than stylistic. Every
    // subscription.* event carries the full entity, so an explicit null means
    // the customer withdrew the cancellation. Skipping the column on update
    // would leave a live subscription looking dead forever, blocking deletion
    // and telling /account it ends on a date that will never come.
    await applyBillingEvent(
      db,
      billingEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )
    expect((await subscriptionRow())?.scheduledChangeAction).toBe('cancel')

    await applyBillingEvent(
      db,
      billingEventSchema.parse(subscriptionEvent({ scheduled_change: null })),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBeNull()
    expect(row?.scheduledChangeAt).toBeNull()
    expect(isBillingLive(row!)).toBe(true)
  })

  it('clears it when the field is absent entirely, not just explicitly null', async () => {
    // The normalizer may omit the key rather than null it; absent and
    // null have to mean the same thing here.
    await applyBillingEvent(
      db,
      billingEventSchema.parse(
        subscriptionEvent({ scheduled_change: { action: 'cancel', effective_at: null } }),
      ),
    )
    await applyBillingEvent(db, billingEventSchema.parse(subscriptionEvent()))

    expect((await subscriptionRow())?.scheduledChangeAction).toBeNull()
  })

  it('keeps a pause scheduled without calling the subscription dead', async () => {
    // A pause resumes and bills again; only a cancel ends the money.
    await applyBillingEvent(
      db,
      billingEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'pause', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBe('pause')
    expect(isBillingLive(row!)).toBe(true)
  })

  it('tolerates a cancel with no effective date', async () => {
    await applyBillingEvent(
      db,
      billingEventSchema.parse(subscriptionEvent({ scheduled_change: { action: 'cancel' } })),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBe('cancel')
    expect(row?.scheduledChangeAt).toBeNull()
    expect(isBillingLive(row!)).toBe(false)
  })
})

// ─── What was bought is the price, not the buyer's claim ────────────────────
// `custom_data` is written by the browser, so a genuine signed event can carry
// any productKey the buyer typed. The webhook grants only for a price it was
// configured with, of the kind the event implies.

describe('price catalogue', () => {
  it('grants nothing for a price this deployment does not sell', async () => {
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_stranger',
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        items: [{ price: { id: 'price_somebody_elses' } }],
      }),
    )

    expect(outcome).toMatchObject({
      kind: 'ignored',
      reason: 'unrecognised_price',
      detail: 'unknown_price',
      priceIds: ['price_somebody_elses'],
    })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('refuses a basket that mixes a known price with an unknown one', async () => {
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_mixed',
        custom_data: { userId: USER },
        items: [{ price: { id: PRICES.pass } }, { price: { id: 'price_addon' } }],
      }),
    )

    expect(outcome).toMatchObject({ kind: 'ignored', detail: 'unknown_price' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('refuses a one-time transaction for a subscription price, and vice versa', async () => {
    const passOnSubscription = await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_wrong',
        status: 'active',
        custom_data: { userId: USER },
        items: PASS_ITEMS,
        current_billing_period: { ends_at: new Date(Date.now() + 20 * DAY_MS).toISOString() },
      }),
    )
    const subscriptionOnPass = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_wrong',
        custom_data: { userId: USER },
        items: SUBSCRIPTION_ITEMS,
      }),
    )

    expect(passOnSubscription).toMatchObject({ kind: 'ignored', detail: 'wrong_kind' })
    expect(subscriptionOnPass).toMatchObject({ kind: 'ignored', detail: 'wrong_kind' })
    expect(await db.query.entitlements.findMany()).toHaveLength(0)
  })

  it('ignores an event with no items at all', async () => {
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_bare',
        custom_data: { userId: USER },
        items: null,
      }),
    )

    expect(outcome).toMatchObject({ kind: 'ignored', detail: 'no_items' })
  })

  it('takes the product from the price, whatever custom_data claims', async () => {
    const premium = priceCatalogue({ stripePricePass: 'price_premium' }, 'premium')
    const outcome = await applyBillingEvent(
      db,
      billingEvent('transaction.completed', {
        id: 'pi_claim',
        // A productKey here is the buyer's claim; the schema drops it and the
        // grant follows the price's product regardless.
        custom_data: { userId: USER, productKey: 'enterprise' },
        items: [{ price: { id: 'price_premium' } }],
      }),
      premium,
    )

    expect(outcome).toMatchObject({ kind: 'pass', granted: true })
    expect(await findActiveEntitlement(db, USER, 'enterprise')).toBeNull()
    expect((await findActiveEntitlement(db, USER, 'premium'))?.status).toBe('active')
  })

  it('grants nothing when no prices are configured', async () => {
    const outcome = await applyBillingEvent(
      db,
      passPurchase('pi_unconfigured', new Date()),
      priceCatalogue({}),
    )

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'unrecognised_price' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('still applies a cancellation to a row whose price was rotated out of config', async () => {
    const endsAt = new Date(Date.now() + 20 * DAY_MS)
    await applyBillingEvent(
      db,
      billingEvent('subscription.created', {
        id: 'sub_rotated',
        status: 'active',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
    )
    expect((await findActiveEntitlement(db, USER))?.status).toBe('active')

    // The operator replaced the monthly price; the old subscription keeps
    // reporting the old price id. Its status must still follow Stripe.
    const rotated = priceCatalogue({ stripePriceMonthly: 'price_monthly_v2' })
    const outcome = await applyBillingEvent(
      db,
      billingEvent('subscription.canceled', {
        id: 'sub_rotated',
        status: 'canceled',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
      rotated,
    )

    expect(outcome).toMatchObject({ kind: 'subscription', status: 'canceled' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })
})
