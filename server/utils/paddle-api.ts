// Paddle REST API client — the small slice we call server-side.
//
// Needs a server-side API key (Paddle → Developer tools → Authentication) in
// NUXT_PADDLE_API_KEY. Without it every call here throws a 503-shaped error,
// and the UI falls back to "manage billing from your Paddle receipt email" —
// the product still works, cancellation just costs the user an extra click.
//
// Docs: developer.paddle.com/build/customers/integrate-customer-portal

const SANDBOX_BASE = 'https://sandbox-api.paddle.com'
const PRODUCTION_BASE = 'https://api.paddle.com'

export function paddleApiBase(environment: string): string {
  return environment === 'production' ? PRODUCTION_BASE : SANDBOX_BASE
}

export interface PortalLinks {
  overviewUrl: string
  cancelUrl: string | null
  updatePaymentMethodUrl: string | null
}

interface PortalSessionResponse {
  data?: {
    urls?: {
      general?: { overview?: string }
      subscriptions?: {
        id: string
        cancel_subscription?: string
        update_subscription_payment_method?: string
      }[]
    }
  }
}

/**
 * Mint an authenticated customer-portal session. The links carry a short-lived
 * token (~24h) that logs the customer straight in, so they must never be
 * cached or shared — we mint a fresh one per click.
 *
 * `subscriptionIds` deep-links the cancel/update-payment-method actions; pass
 * the user's live subscriptions to get a one-click cancel URL back.
 */
export async function createPortalSession(opts: {
  apiKey: string
  environment: string
  customerId: string
  subscriptionIds?: string[]
}): Promise<PortalLinks> {
  const res = await fetch(
    `${paddleApiBase(opts.environment)}/customers/${opts.customerId}/portal-sessions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        opts.subscriptionIds?.length ? { subscription_ids: opts.subscriptionIds } : {},
      ),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Paddle portal-sessions ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as PortalSessionResponse
  const overviewUrl = json.data?.urls?.general?.overview
  if (!overviewUrl) throw new Error('Paddle portal-sessions returned no overview URL')
  const sub = json.data?.urls?.subscriptions?.[0]
  return {
    overviewUrl,
    cancelUrl: sub?.cancel_subscription ?? null,
    updatePaymentMethodUrl: sub?.update_subscription_payment_method ?? null,
  }
}
