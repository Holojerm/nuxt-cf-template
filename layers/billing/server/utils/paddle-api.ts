// Paddle REST API client — the small slice we call server-side.
//
// Needs a server-side API key (Paddle → Developer tools → Authentication) in
// NUXT_PADDLE_API_KEY. It is required once billing is on: the cancel button on
// /account calls this, and without the key every call 503s and the toast
// names the support address. No "reply to your receipt" fallback, by design.
//
// The key needs `customer_portal_session.write` for the portal and, with
// `billing.cancelOnDeletion` on, `subscription.write` for cancelSubscription()
// below (Developer tools › Authentication).
//
// Docs: developer.paddle.com/build/customers/integrate-customer-portal

const SANDBOX_BASE = 'https://sandbox-api.paddle.com'
const PRODUCTION_BASE = 'https://api.paddle.com'

/**
 * `override` is NUXT_PADDLE_API_BASE: empty (the default) means Paddle's own
 * host. It exists so the replay script and tests can point the client at a stub;
 * the API key is sent wherever it points, so a deployment never sets it.
 */
export function paddleApiBase(environment: string, override = ''): string {
  if (override) return override.replace(/\/+$/, '')
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
  apiBase?: string
  customerId: string
  subscriptionIds?: string[]
}): Promise<PortalLinks> {
  const res = await fetch(
    `${paddleApiBase(opts.environment, opts.apiBase)}/customers/${opts.customerId}/portal-sessions`,
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

/**
 * A failed Paddle call, reduced to what is safe to log: the HTTP status (0 when
 * no response arrived) and Paddle's short snake_case error code. The response
 * body is never kept — it can echo customer data — and neither is the key.
 */
export class PaddleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Paddle API error: status ${status}, code ${code ?? 'none'}`)
    this.name = 'PaddleApiError'
  }
}

/** Paddle's answer when asked to cancel something already canceled. Final state, so not a failure. */
const ALREADY_CANCELED_CODES = [
  'subscription_is_canceled_action_invalid',
  'subscription_update_when_canceled',
]

const CANCEL_TIMEOUT_MS = 10_000

/**
 * Cancel a subscription immediately: `POST /subscriptions/{id}/cancel` with
 * `effective_from: "immediately"`. Needs the `subscription.write` permission on
 * the API key; without it Paddle answers 403 and this throws.
 *
 * Resolves `'already_canceled'` when Paddle reports the subscription is already
 * canceled — that state is final, so the goal (it will not bill again) holds.
 * Every other failure throws a PaddleApiError.
 */
export async function cancelSubscription(opts: {
  apiKey: string
  environment: string
  apiBase?: string
  subscriptionId: string
}): Promise<'canceled' | 'already_canceled'> {
  let res: Response
  try {
    res = await fetch(
      `${paddleApiBase(opts.environment, opts.apiBase)}/subscriptions/${encodeURIComponent(opts.subscriptionId)}/cancel`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ effective_from: 'immediately' }),
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      },
    )
  } catch {
    throw new PaddleApiError(0, 'network_error')
  }
  if (res.ok) return 'canceled'

  let code: string | null = null
  try {
    const raw = ((await res.json()) as { error?: { code?: unknown } }).error?.code
    if (typeof raw === 'string' && /^[a-z0-9_]{1,64}$/.test(raw)) code = raw
  } catch {
    // Not JSON (a gateway page): status alone is the signal.
  }
  if (res.status === 400 && code && ALREADY_CANCELED_CODES.includes(code)) return 'already_canceled'
  throw new PaddleApiError(res.status, code)
}
