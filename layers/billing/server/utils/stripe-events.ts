// Stripe webhook events → the layer's own billing event.
//
// Everything past the webhook (the entitlement writes, the emails, the outcome
// handlers, the tests) speaks one provider-neutral shape, `BillingEvent`
// (entitlements.ts): `subscription.*`, `transaction.completed` and
// `adjustment.*`. This file is the only place that knows what Stripe's payloads
// look like, so a change of Stripe's wire format is a change here and nowhere
// else.
//
//   customer.subscription.created|updated|deleted  → subscription.created|updated|canceled
//   checkout.session.completed (mode=payment, paid) → transaction.completed   (the one-time pass)
//   checkout.session.async_payment_succeeded        → transaction.completed
//   charge.refunded                                 → adjustment.created, action `refund`
//   charge.dispute.created|closed|funds_reinstated  → adjustment.*, action `chargeback`
//
// Two things a Stripe payload does not carry are fetched through `deps`: the
// line items of a Checkout Session, and the invoice and subscription behind a
// refunded or disputed payment. The route wires them to stripe-api.ts; tests
// pass stubs.

import { z } from 'zod'
import type { BillingEvent } from './entitlements'
import type { BillingItemLike } from './stripe-prices'
import type { PaymentRefs } from './stripe-api'

/** The envelope. `data.object` is validated per event type below. */
export const stripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  // Seconds. The ordering key for a row (`last_event_at`); Stripe does not
  // guarantee delivery order.
  created: z.number(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
})

export type StripeEvent = z.infer<typeof stripeEventSchema>

/** A handled event type whose object did not have the shape this file reads. */
export class StripeEventShapeError extends Error {
  constructor(readonly eventType: string) {
    super(`Stripe ${eventType} did not match the expected shape`)
    this.name = 'StripeEventShapeError'
  }
}

export interface NormalizeDeps {
  lineItems: (sessionId: string) => Promise<BillingItemLike[]>
  paymentRefs: (paymentIntentId: string) => Promise<PaymentRefs | null>
}

/** An expandable field: the id, or the object when the endpoint's payload expanded it. */
const ref = z.union([z.string(), z.object({ id: z.string() })]).nullish()

function idOf(value: z.infer<typeof ref>): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

const metadata = z.object({ userId: z.string().max(128).optional() }).nullish()

const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  customer: ref,
  metadata,
  cancel_at_period_end: z.boolean().nullish(),
  cancel_at: z.number().nullish(),
  latest_invoice: ref,
  // Top-level before `2025-03-31.basil`, on each item since. Both are read so an
  // endpoint created on an older version still yields a period end.
  current_period_end: z.number().nullish(),
  items: z.object({
    data: z.array(
      z.object({
        current_period_end: z.number().nullish(),
        price: z.object({ id: z.string(), product: ref }).nullish(),
      }),
    ),
  }),
})

const sessionSchema = z.object({
  id: z.string(),
  mode: z.string(),
  payment_status: z.string().nullish(),
  payment_intent: ref,
  customer: ref,
  client_reference_id: z.string().max(200).nullish(),
  metadata,
})

const chargeSchema = z.object({
  id: z.string(),
  payment_intent: ref,
  refunded: z.boolean().nullish(),
})

const disputeSchema = z.object({
  id: z.string(),
  status: z.string(),
  charge: ref,
  payment_intent: ref,
})

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

function parse<T>(schema: z.ZodType<T>, event: StripeEvent): T {
  const parsed = schema.safeParse(event.data.object)
  if (!parsed.success) throw new StripeEventShapeError(event.type)
  return parsed.data
}

const SUBSCRIPTION_EVENT_TYPES: Record<string, string> = {
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.paused': 'subscription.updated',
  'customer.subscription.resumed': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.canceled',
}

/**
 * Statuses of a subscription whose first payment never completed. No row is
 * written for them: a customer who abandons a card challenge has bought
 * nothing, and the `updated` event that follows a successful first payment
 * creates the row as `active`.
 */
const NEVER_STARTED_STATUSES = ['incomplete', 'incomplete_expired']

function normalizeSubscription(event: StripeEvent): BillingEvent | null {
  const sub = parse(subscriptionSchema, event)
  if (NEVER_STARTED_STATUSES.includes(sub.status)) return null

  const periodEnds = sub.items.data
    .map((item) => item.current_period_end)
    .filter((end): end is number => typeof end === 'number')
  const periodEnd = periodEnds.length ? Math.max(...periodEnds) : (sub.current_period_end ?? null)

  // A cancel the customer has scheduled does not change `status`; Stripe keeps
  // it `active` until the date. Newer API versions express it as `cancel_at`
  // alone, older ones as `cancel_at_period_end`.
  const cancelAt = sub.cancel_at ?? (sub.cancel_at_period_end ? periodEnd : null)
  const scheduled = Boolean(sub.cancel_at_period_end || sub.cancel_at)

  return {
    event_id: event.id,
    event_type: SUBSCRIPTION_EVENT_TYPES[event.type]!,
    occurred_at: iso(event.created),
    data: {
      id: sub.id,
      status: sub.status,
      customer_id: idOf(sub.customer),
      custom_data: sub.metadata?.userId ? { userId: sub.metadata.userId } : null,
      items: sub.items.data.map((item) => ({
        price: item.price ? { id: item.price.id, product_id: idOf(item.price.product) } : null,
      })),
      current_billing_period: periodEnd ? { ends_at: iso(periodEnd) } : null,
      scheduled_change: scheduled
        ? { action: 'cancel', effective_at: cancelAt ? iso(cancelAt) : null }
        : null,
      // The first invoice, which only the `created` event can vouch for: on
      // later events `latest_invoice` is whichever renewal came last.
      transaction_id:
        event.type === 'customer.subscription.created' ? idOf(sub.latest_invoice) : null,
    },
  }
}

async function normalizeCheckoutSession(
  event: StripeEvent,
  deps: NormalizeDeps,
): Promise<BillingEvent | null> {
  const session = parse(sessionSchema, event)
  // A subscription checkout is owned by the customer.subscription.* events.
  if (session.mode !== 'payment') return null
  // `completed` with a delayed payment method arrives unpaid; the
  // async_payment_succeeded event is the one that says the money landed.
  if (session.payment_status !== 'paid') return null

  const userId = session.metadata?.userId ?? session.client_reference_id ?? undefined
  return {
    event_id: event.id,
    event_type: 'transaction.completed',
    occurred_at: iso(event.created),
    data: {
      // The PaymentIntent is what a later refund or dispute names, so it is the
      // row's ref. A free session (a 100% coupon) has none and keeps its own id.
      id: idOf(session.payment_intent) ?? session.id,
      status: 'completed',
      customer_id: idOf(session.customer),
      custom_data: userId ? { userId } : null,
      items: await deps.lineItems(session.id),
      billed_at: iso(event.created),
    },
  }
}

/**
 * What a refund or dispute is keyed on: the invoice for a subscription payment
 * (what a referral reward is keyed on), else the PaymentIntent (a pass row's
 * ref). Managed Payments writes an invoice for a one-time payment too, so an
 * invoice alone does not make it a subscription payment.
 */
async function paymentRefs(
  paymentIntentId: string | null,
  fallbackId: string,
  deps: NormalizeDeps,
): Promise<{ transaction_id: string; subscription_id: string | null }> {
  if (!paymentIntentId) return { transaction_id: fallbackId, subscription_id: null }
  const refs = await deps.paymentRefs(paymentIntentId)
  const subscriptionId = refs?.subscriptionId ?? null
  return {
    transaction_id: subscriptionId ? (refs?.invoiceId ?? paymentIntentId) : paymentIntentId,
    subscription_id: subscriptionId,
  }
}

async function normalizeRefund(event: StripeEvent, deps: NormalizeDeps): Promise<BillingEvent> {
  const charge = parse(chargeSchema, event)
  return {
    event_id: event.id,
    event_type: 'adjustment.created',
    occurred_at: iso(event.created),
    data: {
      id: charge.id,
      // `charge.refunded` fires once a refund has succeeded, in part or in full.
      action: 'refund',
      status: 'approved',
      type: charge.refunded ? 'full' : 'partial',
      ...(await paymentRefs(idOf(charge.payment_intent), charge.id, deps)),
    },
  }
}

/**
 * A dispute, in the vocabulary revokeForAdjustment decides on.
 *
 * - `warning_*` is an inquiry (an early fraud warning), not a chargeback: no
 *   funds have moved, so it never revokes. `prevented` was resolved before it
 *   became one; any refund behind it arrives as `charge.refunded`.
 * - A real dispute revokes from the moment it opens: the bank has already
 *   pulled the funds.
 * - `won`, or funds reinstated, is the bank giving the money back: `reversed`.
 */
function disputeAdjustment(eventType: string, status: string): { action: string; status: string } {
  if (status.startsWith('warning_') || status === 'prevented') {
    return { action: 'chargeback_warning', status }
  }
  if (status === 'won' || eventType === 'charge.dispute.funds_reinstated') {
    return { action: 'chargeback', status: 'reversed' }
  }
  return { action: 'chargeback', status }
}

async function normalizeDispute(event: StripeEvent, deps: NormalizeDeps): Promise<BillingEvent> {
  const dispute = parse(disputeSchema, event)
  return {
    event_id: event.id,
    event_type:
      event.type === 'charge.dispute.created' ? 'adjustment.created' : 'adjustment.updated',
    occurred_at: iso(event.created),
    data: {
      id: dispute.id,
      ...disputeAdjustment(event.type, dispute.status),
      ...(await paymentRefs(
        idOf(dispute.payment_intent),
        idOf(dispute.charge) ?? dispute.id,
        deps,
      )),
    },
  }
}

/**
 * Translate one verified Stripe event, or null for one the layer does not act
 * on (acknowledged, so Stripe stops retrying it). Throws StripeEventShapeError
 * when a handled type has an unreadable object, and whatever `deps` throws when
 * a lookup fails: the route answers 400 and 5xx respectively, and Stripe
 * redelivers the latter.
 */
export async function normalizeStripeEvent(
  event: StripeEvent,
  deps: NormalizeDeps,
): Promise<BillingEvent | null> {
  if (event.type in SUBSCRIPTION_EVENT_TYPES) return normalizeSubscription(event)
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    return await normalizeCheckoutSession(event, deps)
  }
  if (event.type === 'charge.refunded') return await normalizeRefund(event, deps)
  if (
    event.type === 'charge.dispute.created' ||
    event.type === 'charge.dispute.closed' ||
    event.type === 'charge.dispute.funds_reinstated'
  ) {
    return await normalizeDispute(event, deps)
  }
  return null
}
