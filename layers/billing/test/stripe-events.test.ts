// Stripe webhook payloads → the layer's own billing event, then through
// applyBillingEvent against a real D1 inside workerd. The only fakes are the two
// lookups the route would make at Stripe (line items, payment refs).

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  applyBillingEvent,
  billingEventSchema,
  findActiveEntitlement,
  type BillingEvent,
} from '../server/utils/entitlements'
import type { BillingItemLike } from '../server/utils/stripe-prices'
import { priceCatalogue } from '../server/utils/stripe-prices'
import {
  StripeEventShapeError,
  normalizeStripeEvent,
  type NormalizeDeps,
  type StripeEvent,
} from '../server/utils/stripe-events'
import type { PaymentRefs } from '../server/utils/stripe-api'

const db = drizzle(env.DB, { schema })
const USER = 'user-events'
const MONTHLY = 'price_monthly'
const PASS = 'price_pass'
const CATALOGUE = priceCatalogue({
  stripePriceMonthly: MONTHLY,
  stripePricePass: PASS,
})
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole seconds, as Stripe stamps events. */
const seconds = (ms: number) => Math.floor(ms / 1000)
const iso = (s: number) => new Date(s * 1000).toISOString()

let lineItems: BillingItemLike[]
let refs: PaymentRefs | null
let lookups: string[]

const deps: NormalizeDeps = {
  lineItems: async (sessionId) => {
    lookups.push(`items:${sessionId}`)
    return lineItems
  },
  paymentRefs: async (paymentIntentId) => {
    lookups.push(`refs:${paymentIntentId}`)
    return refs
  },
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; created?: number } = {},
): StripeEvent {
  return {
    id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created: opts.created ?? seconds(Date.now()),
    data: { object },
  }
}

const normalize = (event: StripeEvent) => normalizeStripeEvent(event, deps)

/** The error a normalization rejects with. Settled here so workerd sees it handled. */
const rejection = (event: StripeEvent, d: NormalizeDeps = deps) =>
  normalizeStripeEvent(event, d).then(
    () => null,
    (error: unknown) => error,
  )

async function normalized(event: StripeEvent): Promise<BillingEvent> {
  const result = await normalize(event)
  expect(result).not.toBeNull()
  // The same schema the route's applyBillingEvent callers rely on.
  return billingEventSchema.parse(result)
}

const subscriptionObject = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  metadata: { userId: USER },
  cancel_at_period_end: false,
  cancel_at: null,
  latest_invoice: 'in_1',
  items: {
    data: [
      {
        current_period_end: 2_000_000_000,
        price: { id: MONTHLY, product: 'prod_1' },
      },
    ],
  },
  ...overrides,
})

const sessionObject = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs_1',
  mode: 'payment',
  payment_status: 'paid',
  payment_intent: 'pi_1',
  customer: 'cus_1',
  client_reference_id: USER,
  metadata: { userId: USER },
  ...overrides,
})

beforeEach(async () => {
  lineItems = [{ price: { id: PASS, product_id: 'prod_1' } }]
  refs = null
  lookups = []
  await db.delete(schema.entitlements)
  await db.delete(schema.billingEvents)
  await db
    .insert(schema.users)
    .values({ id: USER, email: `${USER}@example.com`, name: USER })
    .onConflictDoNothing()
})

describe('customer.subscription.*', () => {
  it('maps created, updated and deleted to the layer’s subscription events', async () => {
    const created = await normalize(
      stripeEvent('customer.subscription.created', subscriptionObject(), {
        id: 'evt_c',
        created: 1_800_000_000,
      }),
    )
    expect(created).toEqual({
      event_id: 'evt_c',
      event_type: 'subscription.created',
      occurred_at: iso(1_800_000_000),
      data: {
        id: 'sub_1',
        status: 'active',
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        items: [{ price: { id: MONTHLY, product_id: 'prod_1' } }],
        current_billing_period: { ends_at: iso(2_000_000_000) },
        scheduled_change: null,
        transaction_id: 'in_1',
      },
    })
    expect(
      (await normalize(stripeEvent('customer.subscription.updated', subscriptionObject())))
        ?.event_type,
    ).toBe('subscription.updated')
    const deleted = await normalize(
      stripeEvent('customer.subscription.deleted', subscriptionObject({ status: 'canceled' })),
    )
    expect(deleted?.event_type).toBe('subscription.canceled')
    expect(deleted?.data.status).toBe('canceled')
  })

  it('maps paused and resumed to updates', async () => {
    for (const type of ['customer.subscription.paused', 'customer.subscription.resumed']) {
      expect((await normalize(stripeEvent(type, subscriptionObject())))?.event_type).toBe(
        'subscription.updated',
      )
    }
  })

  it('takes the period end from the items, the latest one when several', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          items: {
            data: [
              { current_period_end: 1_900_000_000, price: { id: MONTHLY } },
              {
                current_period_end: 2_100_000_000,
                price: { id: 'price_addon' },
              },
            ],
          },
        }),
      ),
    )
    expect(result?.data.current_billing_period).toEqual({
      ends_at: iso(2_100_000_000),
    })
  })

  it('falls back to the top-level period end of older API versions', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          current_period_end: 1_950_000_000,
          items: { data: [{ price: { id: MONTHLY } }] },
        }),
      ),
    )
    expect(result?.data.current_billing_period).toEqual({
      ends_at: iso(1_950_000_000),
    })
  })

  it('has no period when neither place carries one', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ items: { data: [{ price: { id: MONTHLY } }] } }),
      ),
    )
    expect(result?.data.current_billing_period).toBeNull()
  })

  it('turns cancel_at_period_end into a scheduled cancel at the period end', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ cancel_at_period_end: true }),
      ),
    )
    expect(result?.data.scheduled_change).toEqual({
      action: 'cancel',
      effective_at: iso(2_000_000_000),
    })
  })

  it('turns cancel_at alone (newer API versions) into a scheduled cancel on that date', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({ cancel_at: 1_990_000_000 }),
      ),
    )
    expect(result?.data.scheduled_change).toEqual({
      action: 'cancel',
      effective_at: iso(1_990_000_000),
    })
  })

  it('schedules a cancel with no known date when only the flag is set and no period exists', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          cancel_at_period_end: true,
          items: { data: [{ price: { id: MONTHLY } }] },
        }),
      ),
    )
    expect(result?.data.scheduled_change).toEqual({
      action: 'cancel',
      effective_at: null,
    })
  })

  it.each(['incomplete', 'incomplete_expired'])('acknowledges %s with no event', async (status) => {
    expect(
      await normalize(stripeEvent('customer.subscription.created', subscriptionObject({ status }))),
    ).toBeNull()
  })

  it('carries latest_invoice as transaction_id on created only', async () => {
    const created = await normalize(
      stripeEvent('customer.subscription.created', subscriptionObject()),
    )
    const updated = await normalize(
      stripeEvent('customer.subscription.updated', subscriptionObject()),
    )
    expect(created?.data.transaction_id).toBe('in_1')
    expect(updated?.data.transaction_id).toBeNull()
  })

  it('reads an expanded customer object and an expanded latest_invoice', async () => {
    const result = await normalize(
      stripeEvent(
        'customer.subscription.created',
        subscriptionObject({
          customer: { id: 'cus_obj' },
          latest_invoice: { id: 'in_obj' },
        }),
      ),
    )
    expect(result?.data.customer_id).toBe('cus_obj')
    expect(result?.data.transaction_id).toBe('in_obj')
  })

  it('drops a missing userId into null custom_data', async () => {
    const result = await normalize(
      stripeEvent('customer.subscription.updated', subscriptionObject({ metadata: {} })),
    )
    expect(result?.data.custom_data).toBeNull()
  })

  it('throws StripeEventShapeError for an object without items', async () => {
    const bad = stripeEvent('customer.subscription.updated', {
      id: 'sub_1',
      status: 'active',
    })
    const error = await rejection(bad)
    expect(error).toBeInstanceOf(StripeEventShapeError)
    expect(error).toMatchObject({ eventType: 'customer.subscription.updated' })
  })
})

describe('checkout.session.*', () => {
  it('ignores subscription-mode sessions: the subscription events own them', async () => {
    expect(
      await normalize(
        stripeEvent('checkout.session.completed', sessionObject({ mode: 'subscription' })),
      ),
    ).toBeNull()
    expect(lookups).toEqual([])
  })

  it('ignores an unpaid session (delayed payment method)', async () => {
    expect(
      await normalize(
        stripeEvent('checkout.session.completed', sessionObject({ payment_status: 'unpaid' })),
      ),
    ).toBeNull()
    expect(lookups).toEqual([])
  })

  it('maps a paid payment session to transaction.completed keyed on the PaymentIntent', async () => {
    const created = 1_800_000_000
    const result = await normalize(
      stripeEvent('checkout.session.completed', sessionObject(), {
        id: 'evt_s',
        created,
      }),
    )
    expect(result).toEqual({
      event_id: 'evt_s',
      event_type: 'transaction.completed',
      occurred_at: iso(created),
      data: {
        id: 'pi_1',
        status: 'completed',
        customer_id: 'cus_1',
        custom_data: { userId: USER },
        items: [{ price: { id: PASS, product_id: 'prod_1' } }],
        billed_at: iso(created),
      },
    })
    expect(lookups).toEqual(['items:cs_1'])
  })

  it('maps async_payment_succeeded the same way', async () => {
    const result = await normalize(
      stripeEvent('checkout.session.async_payment_succeeded', sessionObject()),
    )
    expect(result?.event_type).toBe('transaction.completed')
    expect(result?.data.id).toBe('pi_1')
  })

  it('reads the user from metadata first, then client_reference_id', async () => {
    const both = await normalize(
      stripeEvent(
        'checkout.session.completed',
        sessionObject({
          metadata: { userId: 'from-meta' },
          client_reference_id: 'from-ref',
        }),
      ),
    )
    expect(both?.data.custom_data).toEqual({ userId: 'from-meta' })
    const refOnly = await normalize(
      stripeEvent(
        'checkout.session.completed',
        sessionObject({ metadata: null, client_reference_id: 'from-ref' }),
      ),
    )
    expect(refOnly?.data.custom_data).toEqual({ userId: 'from-ref' })
    const neither = await normalize(
      stripeEvent(
        'checkout.session.completed',
        sessionObject({ metadata: null, client_reference_id: null }),
      ),
    )
    expect(neither?.data.custom_data).toBeNull()
  })

  it('keys a free session (no PaymentIntent) on the session id', async () => {
    const result = await normalize(
      stripeEvent('checkout.session.completed', sessionObject({ payment_intent: null })),
    )
    expect(result?.data.id).toBe('cs_1')
  })

  it('throws StripeEventShapeError for a session without an id', async () => {
    expect(
      await rejection(stripeEvent('checkout.session.completed', { mode: 'payment' })),
    ).toBeInstanceOf(StripeEventShapeError)
  })
})

describe('charge.refunded', () => {
  const charge = (overrides: Record<string, unknown> = {}) => ({
    id: 'ch_1',
    payment_intent: 'pi_1',
    refunded: true,
    ...overrides,
  })

  it('maps a full refund, keyed on the invoice and subscription found at Stripe', async () => {
    refs = { invoiceId: 'in_1', subscriptionId: 'sub_1' }
    const result = await normalize(
      stripeEvent('charge.refunded', charge(), {
        id: 'evt_r',
        created: 1_800_000_000,
      }),
    )
    expect(result).toEqual({
      event_id: 'evt_r',
      event_type: 'adjustment.created',
      occurred_at: iso(1_800_000_000),
      data: {
        id: 'ch_1',
        action: 'refund',
        status: 'approved',
        type: 'full',
        transaction_id: 'in_1',
        subscription_id: 'sub_1',
      },
    })
    expect(lookups).toEqual(['refs:pi_1'])
  })

  it('maps a partial refund (refunded false)', async () => {
    const result = await normalize(stripeEvent('charge.refunded', charge({ refunded: false })))
    expect(result?.data.type).toBe('partial')
  })

  it('falls back to the PaymentIntent id when the payment has no invoice', async () => {
    refs = null
    const result = await normalize(stripeEvent('charge.refunded', charge()))
    expect(result?.data.transaction_id).toBe('pi_1')
    expect(result?.data.subscription_id).toBeNull()
  })

  it('keys a pass refund on the PaymentIntent when Managed Payments wrote an invoice for it', async () => {
    refs = { invoiceId: 'in_pass', subscriptionId: null }
    const result = await normalize(stripeEvent('charge.refunded', charge()))
    expect(result?.data.transaction_id).toBe('pi_1')
    expect(result?.data.subscription_id).toBeNull()
    expect(lookups).toEqual(['refs:pi_1'])
  })

  it('uses the charge id when there is no PaymentIntent to look up', async () => {
    const result = await normalize(stripeEvent('charge.refunded', charge({ payment_intent: null })))
    expect(result?.data.transaction_id).toBe('ch_1')
    expect(lookups).toEqual([])
  })

  it('lets a failed lookup propagate so the route can answer 5xx', async () => {
    const failing: NormalizeDeps = {
      ...deps,
      paymentRefs: async () => {
        throw new Error('stripe down')
      },
    }
    const error = await rejection(stripeEvent('charge.refunded', charge()), failing)
    expect(error).toMatchObject({ message: 'stripe down' })
  })
})

describe('charge.dispute.*', () => {
  const dispute = (status: string, overrides: Record<string, unknown> = {}) => ({
    id: 'dp_1',
    status,
    charge: 'ch_1',
    payment_intent: 'pi_1',
    ...overrides,
  })

  it('maps a created dispute to a chargeback from the moment it opens', async () => {
    refs = { invoiceId: 'in_1', subscriptionId: 'sub_1' }
    const result = await normalize(
      stripeEvent('charge.dispute.created', dispute('needs_response'), {
        id: 'evt_d',
      }),
    )
    expect(result).toMatchObject({
      event_id: 'evt_d',
      event_type: 'adjustment.created',
      data: {
        id: 'dp_1',
        action: 'chargeback',
        status: 'needs_response',
        transaction_id: 'in_1',
        subscription_id: 'sub_1',
      },
    })
  })

  it.each(['warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented'])(
    'maps %s to a chargeback_warning, which never revokes',
    async (status) => {
      const result = await normalize(stripeEvent('charge.dispute.created', dispute(status)))
      expect(result?.data).toMatchObject({
        action: 'chargeback_warning',
        status,
      })
    },
  )

  it('maps a closed dispute that was won to a reversed chargeback', async () => {
    const result = await normalize(stripeEvent('charge.dispute.closed', dispute('won')))
    expect(result?.event_type).toBe('adjustment.updated')
    expect(result?.data).toMatchObject({
      action: 'chargeback',
      status: 'reversed',
    })
  })

  it('maps funds_reinstated to a reversed chargeback whatever the status says', async () => {
    const result = await normalize(
      stripeEvent('charge.dispute.funds_reinstated', dispute('under_review')),
    )
    expect(result?.event_type).toBe('adjustment.updated')
    expect(result?.data).toMatchObject({
      action: 'chargeback',
      status: 'reversed',
    })
  })

  it('maps a closed dispute that was lost to a chargeback with status lost', async () => {
    const result = await normalize(stripeEvent('charge.dispute.closed', dispute('lost')))
    expect(result?.data).toMatchObject({
      action: 'chargeback',
      status: 'lost',
    })
  })

  it('keys a pass dispute on the PaymentIntent when Managed Payments wrote an invoice for it', async () => {
    refs = { invoiceId: 'in_pass', subscriptionId: null }
    const result = await normalize(stripeEvent('charge.dispute.created', dispute('needs_response')))
    expect(result?.data).toMatchObject({ transaction_id: 'pi_1', subscription_id: null })
  })

  it('keys a dispute on the PaymentIntent when the payment has no invoice', async () => {
    refs = null
    const result = await normalize(stripeEvent('charge.dispute.created', dispute('needs_response')))
    expect(result?.data).toMatchObject({ transaction_id: 'pi_1', subscription_id: null })
  })

  it('falls back to the charge id with no PaymentIntent', async () => {
    const result = await normalize(
      stripeEvent('charge.dispute.created', dispute('needs_response', { payment_intent: null })),
    )
    expect(result?.data.transaction_id).toBe('ch_1')
  })

  it('throws StripeEventShapeError for a dispute without a status', async () => {
    expect(await rejection(stripeEvent('charge.dispute.created', { id: 'dp_1' }))).toBeInstanceOf(
      StripeEventShapeError,
    )
  })
})

describe('everything else', () => {
  it.each(['customer.created', 'invoice.paid', 'payment_intent.succeeded', 'charge.succeeded'])(
    'acknowledges %s with no event and no lookup',
    async (type) => {
      expect(await normalize(stripeEvent(type, { id: 'x' }))).toBeNull()
      expect(lookups).toEqual([])
    },
  )
})

describe('normalized events through applyBillingEvent', () => {
  it('activates a monthly subscription', async () => {
    const event = await normalized(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          items: {
            data: [
              {
                current_period_end: seconds(Date.now() + 20 * DAY_MS),
                price: { id: MONTHLY },
              },
            ],
          },
        }),
      ),
    )
    const outcome = await applyBillingEvent(db, event, CATALOGUE)
    expect(outcome).toMatchObject({
      kind: 'subscription',
      userId: USER,
      status: 'active',
    })

    const active = await findActiveEntitlement(db, USER)
    expect(active).toMatchObject({
      billingRef: 'sub_1',
      status: 'active',
    })
    expect(active?.currentPeriodEnd).toBeInstanceOf(Date)
  })

  it('ignores a late created in the same second as the updated that activated it, and backfills firstTransactionId', async () => {
    const at = seconds(Date.now())
    const active = await normalized(
      stripeEvent('customer.subscription.updated', subscriptionObject(), {
        created: at,
      }),
    )
    expect(await applyBillingEvent(db, active, CATALOGUE)).toMatchObject({
      kind: 'subscription',
      status: 'active',
    })

    // Same second, status still `incomplete`-adjacent (`past_due` here) so a
    // wrongly applied `created` would be visible as a status change.
    const late = await normalized(
      stripeEvent('customer.subscription.created', subscriptionObject({ status: 'past_due' }), {
        created: at,
      }),
    )
    expect(await applyBillingEvent(db, late, CATALOGUE)).toEqual({
      kind: 'ignored',
      reason: 'stale_event',
    })

    const row = await db.query.entitlements.findFirst({
      where: eq(schema.entitlements.billingRef, 'sub_1'),
    })
    expect(row?.status).toBe('active')
    expect(row?.firstTransactionId).toBe('in_1')
  })

  // Managed Payments writes an invoice for a one-time payment too (seen in test
  // mode 2026-11-22); the pass row is still keyed on its PaymentIntent.
  const PASS_REFS: [string, PaymentRefs | null][] = [
    ['no invoice', null],
    ['an invoice with no subscription', { invoiceId: 'in_pass', subscriptionId: null }],
  ]

  it.each(PASS_REFS)(
    'grants a pass from a paid session, then charge.refunded revokes it (%s)',
    async (_, passRefs) => {
      const purchase = await normalized(
        stripeEvent('checkout.session.completed', sessionObject(), {
          created: seconds(Date.now() - 60_000),
        }),
      )
      expect(await applyBillingEvent(db, purchase, CATALOGUE)).toMatchObject({
        kind: 'pass',
        userId: USER,
        granted: true,
      })
      expect(await findActiveEntitlement(db, USER)).toMatchObject({
        billingRef: 'pi_1',
      })

      refs = passRefs
      const refund = await normalized(
        stripeEvent('charge.refunded', {
          id: 'ch_1',
          payment_intent: 'pi_1',
          refunded: true,
        }),
      )
      expect(await applyBillingEvent(db, refund, CATALOGUE)).toMatchObject({
        kind: 'adjustment',
        action: 'refund',
        result: { outcome: 'revoked', userId: USER, billingRef: 'pi_1' },
      })
      expect(await findActiveEntitlement(db, USER)).toBeNull()
    },
  )

  it('revokes a subscription through the invoice payment behind a refund', async () => {
    const active = await normalized(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionObject({
          items: {
            data: [
              {
                current_period_end: seconds(Date.now() + 20 * DAY_MS),
                price: { id: MONTHLY },
              },
            ],
          },
        }),
        { created: seconds(Date.now() - 60_000) },
      ),
    )
    await applyBillingEvent(db, active, CATALOGUE)

    refs = { invoiceId: 'in_9', subscriptionId: 'sub_1' }
    const refund = await normalized(
      stripeEvent('charge.refunded', {
        id: 'ch_9',
        payment_intent: 'pi_9',
        refunded: true,
      }),
    )
    expect(await applyBillingEvent(db, refund, CATALOGUE)).toMatchObject({
      result: { outcome: 'revoked', billingRef: 'sub_1' },
    })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it.each(PASS_REFS)(
    'revokes a pass when a dispute opens and restores it when the dispute is won (%s)',
    async (_, passRefs) => {
      refs = passRefs
      const purchase = await normalized(
        stripeEvent('checkout.session.completed', sessionObject(), {
          created: seconds(Date.now() - 3_600_000),
        }),
      )
      await applyBillingEvent(db, purchase, CATALOGUE)
      expect(await findActiveEntitlement(db, USER)).not.toBeNull()

      const opened = await normalized(
        stripeEvent(
          'charge.dispute.created',
          {
            id: 'dp_1',
            status: 'needs_response',
            charge: 'ch_1',
            payment_intent: 'pi_1',
          },
          { created: seconds(Date.now() - 1_800_000) },
        ),
      )
      expect(await applyBillingEvent(db, opened, CATALOGUE)).toMatchObject({
        kind: 'adjustment',
        action: 'chargeback',
        result: { outcome: 'revoked', billingRef: 'pi_1' },
      })
      expect(await findActiveEntitlement(db, USER)).toBeNull()

      const won = await normalized(
        stripeEvent(
          'charge.dispute.closed',
          { id: 'dp_1', status: 'won', charge: 'ch_1', payment_intent: 'pi_1' },
          { created: seconds(Date.now() - 600_000) },
        ),
      )
      expect(await applyBillingEvent(db, won, CATALOGUE)).toMatchObject({
        kind: 'adjustment',
        result: { outcome: 'reversed' },
      })
      expect(await findActiveEntitlement(db, USER)).toMatchObject({
        billingRef: 'pi_1',
      })
    },
  )

  it('does not revoke on a dispute early warning', async () => {
    const purchase = await normalized(
      stripeEvent('checkout.session.completed', sessionObject(), {
        created: seconds(Date.now() - 3_600_000),
      }),
    )
    await applyBillingEvent(db, purchase, CATALOGUE)

    const warning = await normalized(
      stripeEvent('charge.dispute.created', {
        id: 'dp_w',
        status: 'warning_needs_response',
        charge: 'ch_1',
        payment_intent: 'pi_1',
      }),
    )
    await applyBillingEvent(db, warning, CATALOGUE)
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })
})
