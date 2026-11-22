// Stripe REST API client: the small slice the layer calls server-side, with
// `fetch` and form encoding. No Stripe package: hosted Checkout needs no
// browser script, and these few calls do not earn a dependency.
//
// Needs a secret key in NUXT_STRIPE_SECRET_KEY (a restricted key works: write
// on Checkout Sessions, Customer portal and Subscriptions; read on Invoices).
// It is required once billing is on: checkout, the cancel button on /account
// and the webhook's own lookups all call this.
//
// Docs: docs.stripe.com/api

import type { BillingItemLike } from './stripe-prices'

/**
 * The API version every request is pinned to, so a change of the account's
 * default cannot change a response shape under this code. Managed Payments
 * needs `2025-03-31.basil` or later. Create the webhook endpoint on the same
 * version: the event payloads the webhook parses are shaped by the ENDPOINT's
 * version, not by this header.
 */
export const STRIPE_API_VERSION = '2026-11-18.endive'

const STRIPE_API_BASE = 'https://api.stripe.com'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * `override` is NUXT_STRIPE_API_BASE: empty (the default) means Stripe's own
 * host. It exists so the replay script and tests can point the client at a
 * stub; the key is sent wherever it points, so a deployment never sets it.
 */
export function stripeApiBase(override = ''): string {
  return override ? override.replace(/\/+$/, '') : STRIPE_API_BASE
}

/**
 * A failed Stripe call, reduced to what is safe to log: the HTTP status (0 when
 * no response arrived) and Stripe's short snake_case error code (its error type
 * when it sent no code). The response body is never kept, because it can echo
 * customer data, and neither is the key.
 */
export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Stripe API error: status ${status}, code ${code ?? 'none'}`)
    this.name = 'StripeApiError'
  }
}

export interface StripeClientOptions {
  secretKey: string
  apiBase?: string
}

type Params = [key: string, value: string][]

async function stripeRequest<T>(
  opts: StripeClientOptions,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Params = [],
): Promise<T> {
  const encoded = new URLSearchParams(params).toString()
  const url = `${stripeApiBase(opts.apiBase)}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${opts.secretKey}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: encoded } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new StripeApiError(0, 'network_error')
  }
  if (res.ok) return (await res.json()) as T

  let code: string | null = null
  try {
    const error = ((await res.json()) as { error?: { code?: unknown; type?: unknown } }).error
    const raw = error?.code ?? error?.type
    if (typeof raw === 'string' && /^[a-z0-9_]{1,64}$/.test(raw)) code = raw
  } catch {
    // Not JSON (a gateway page): status alone is the signal.
  }
  throw new StripeApiError(res.status, code)
}

export interface CheckoutSessionInput extends StripeClientOptions {
  /** `subscription` for the monthly plan, `payment` for the one-time pass. */
  mode: 'subscription' | 'payment'
  priceId: string
  /** The signed-in account. Set by this server, never by the browser. */
  userId: string
  /** An existing Stripe customer (`cus_…`) to reuse; wins over `customerEmail`. */
  customerId?: string | null
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
}

/**
 * Create a hosted Checkout Session sold through Stripe Managed Payments
 * (Stripe, as Link, is the merchant of record and owns tax, fraud and
 * disputes). Managed Payments works only on hosted Checkout, takes no
 * `automatic_tax`, `payment_method_types` or statement-descriptor parameters,
 * and needs an eligible tax code on the product.
 *
 * The account travels three ways because each event reads a different object:
 * the session (`client_reference_id`, `metadata`), the subscription
 * (`subscription_data.metadata`) and the payment (`payment_intent_data.metadata`).
 */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<{ id: string; url: string }> {
  const params: Params = [
    ['mode', input.mode],
    ['managed_payments[enabled]', 'true'],
    ['line_items[0][price]', input.priceId],
    ['line_items[0][quantity]', '1'],
    ['success_url', input.successUrl],
    ['cancel_url', input.cancelUrl],
    ['client_reference_id', input.userId],
    ['metadata[userId]', input.userId],
    input.mode === 'subscription'
      ? ['subscription_data[metadata][userId]', input.userId]
      : ['payment_intent_data[metadata][userId]', input.userId],
  ]
  // Stripe refuses a session that names both.
  if (input.customerId) params.push(['customer', input.customerId])
  else if (input.customerEmail) params.push(['customer_email', input.customerEmail])

  const session = await stripeRequest<{ id?: string; url?: string | null }>(
    input,
    'POST',
    '/v1/checkout/sessions',
    params,
  )
  if (!session.id || !session.url) throw new StripeApiError(200, 'no_checkout_url')
  return { id: session.id, url: session.url }
}

export interface PortalLinks {
  overviewUrl: string
  cancelUrl: string | null
  updatePaymentMethodUrl: string | null
}

async function portalSession(
  opts: StripeClientOptions,
  customerId: string,
  returnUrl: string,
  flow: Params = [],
): Promise<string> {
  const session = await stripeRequest<{ url?: string }>(
    opts,
    'POST',
    '/v1/billing_portal/sessions',
    [['customer', customerId], ['return_url', returnUrl], ...flow],
  )
  if (!session.url) throw new StripeApiError(200, 'no_portal_url')
  return session.url
}

/**
 * Mint customer-portal links. Each URL is a short-lived session that logs the
 * customer straight in, so they must never be cached or shared: mint per click.
 *
 * With `subscriptionId` (the customer's live subscription) the result also
 * carries deep links to "cancel this subscription" and "update the payment
 * method". Whether a cancel ends the subscription now or at the period end is
 * the portal's own setting (Dashboard › Settings › Billing › Customer portal);
 * the layer expects "at the end of the billing period".
 */
export async function createPortalLinks(
  opts: StripeClientOptions & {
    customerId: string
    returnUrl: string
    subscriptionId?: string | null
  },
): Promise<PortalLinks> {
  const { customerId, returnUrl, subscriptionId } = opts
  const [overviewUrl, cancelUrl, updatePaymentMethodUrl] = await Promise.all([
    portalSession(opts, customerId, returnUrl),
    subscriptionId
      ? portalSession(opts, customerId, returnUrl, [
          ['flow_data[type]', 'subscription_cancel'],
          ['flow_data[subscription_cancel][subscription]', subscriptionId],
        ])
      : null,
    subscriptionId
      ? portalSession(opts, customerId, returnUrl, [['flow_data[type]', 'payment_method_update']])
      : null,
  ])
  return { overviewUrl, cancelUrl, updatePaymentMethodUrl }
}

/**
 * Cancel a subscription immediately: `DELETE /v1/subscriptions/{id}`.
 *
 * Resolves `'already_canceled'` when Stripe refuses but the subscription reads
 * back as canceled (or is gone): that state is final, so the goal (it will not
 * bill again) holds. Every other failure throws a StripeApiError.
 */
export async function cancelSubscription(
  opts: StripeClientOptions & { subscriptionId: string },
): Promise<'canceled' | 'already_canceled'> {
  const path = `/v1/subscriptions/${encodeURIComponent(opts.subscriptionId)}`
  try {
    await stripeRequest(opts, 'DELETE', path)
    return 'canceled'
  } catch (error) {
    if (!(error instanceof StripeApiError) || error.status < 400 || error.status >= 500) throw error
    if (error.status === 401 || error.status === 403) throw error
    try {
      const current = await stripeRequest<{ status?: string }>(opts, 'GET', path)
      if (current.status === 'canceled') return 'already_canceled'
    } catch (lookup) {
      if (lookup instanceof StripeApiError && lookup.status === 404) return 'already_canceled'
    }
    throw error
  }
}

interface LineItemList {
  data?: { price?: { id?: string; product?: string | { id?: string } | null } | null }[]
}

/**
 * What a Checkout Session actually sold. The `checkout.session.completed`
 * payload carries no line items, and the price is the one thing that may decide
 * what a purchase grants (see stripe-prices.ts), so the webhook asks.
 */
export async function listCheckoutLineItems(
  opts: StripeClientOptions & { sessionId: string },
): Promise<BillingItemLike[]> {
  const list = await stripeRequest<LineItemList>(
    opts,
    'GET',
    `/v1/checkout/sessions/${encodeURIComponent(opts.sessionId)}/line_items`,
    [['limit', '20']],
  )
  return (list.data ?? []).map((item) => {
    const product = item.price?.product
    return {
      price: item.price?.id
        ? {
            id: item.price.id,
            product_id: typeof product === 'string' ? product : (product?.id ?? null),
          }
        : null,
    }
  })
}

export interface PaymentRefs {
  /** The invoice the payment settled (`in_…`), when it was a subscription payment. */
  invoiceId: string | null
  /** The subscription that invoice belongs to (`sub_…`). */
  subscriptionId: string | null
}

interface InvoicePaymentList {
  data?: {
    invoice?:
      | string
      | {
          id?: string
          parent?: {
            subscription_details?: { subscription?: string | { id?: string } | null } | null
          } | null
        }
      | null
  }[]
}

/**
 * Which invoice and subscription a payment belongs to, or null for a payment
 * with no invoice (a one-time pass). A refund or dispute names only the charge
 * and its PaymentIntent, and the entitlement to revoke is keyed on the
 * subscription, so the webhook asks.
 */
export async function findPaymentRefs(
  opts: StripeClientOptions & { paymentIntentId: string },
): Promise<PaymentRefs | null> {
  const list = await stripeRequest<InvoicePaymentList>(opts, 'GET', '/v1/invoice_payments', [
    ['payment[type]', 'payment_intent'],
    ['payment[payment_intent]', opts.paymentIntentId],
    ['expand[]', 'data.invoice'],
    ['limit', '1'],
  ])
  const invoice = list.data?.[0]?.invoice
  if (!invoice) return null
  if (typeof invoice === 'string') return { invoiceId: invoice, subscriptionId: null }
  const subscription = invoice.parent?.subscription_details?.subscription
  return {
    invoiceId: invoice.id ?? null,
    subscriptionId: typeof subscription === 'string' ? subscription : (subscription?.id ?? null),
  }
}
