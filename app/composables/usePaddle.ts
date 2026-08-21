// Paddle.js overlay checkout (Paddle Billing, sandbox-first).
//
// Setup: set NUXT_PUBLIC_PADDLE_CLIENT_TOKEN (client-side token from Paddle →
// Developer tools → Authentication) and NUXT_PUBLIC_PADDLE_ENV
// ('sandbox' | 'production'). Empty token = checkout no-ops with a warning, so
// the template runs without a Paddle account.
//
// openCheckout() threads the signed-in user's id through custom_data.userId —
// the webhook (server/routes/paddle/webhook.post.ts) relies on it to map the
// subscription back to the user.
//
// Initialize() also registers an eventCallback, which is the only way to see
// inside the checkout overlay: it is a cross-origin iframe, so autocapture is
// blind to it and abandonment would otherwise be invisible. Mapping and the
// PII allowlist live in app/utils/checkout.ts.

interface PaddleCheckoutItem {
  priceId: string
  quantity?: number
}

interface PaddleCheckoutEvent {
  name: string
  data?: unknown
}

interface PaddleJs {
  Environment: { set(env: 'sandbox' | 'production'): void }
  Initialize(opts: { token: string; eventCallback?: (event: PaddleCheckoutEvent) => void }): void
  Checkout: {
    open(opts: {
      items: { priceId: string; quantity: number }[]
      customer?: { email: string }
      customData?: Record<string, string>
      settings?: { displayMode?: 'overlay' | 'inline'; theme?: 'light' | 'dark'; locale?: string }
    }): void
  }
}

declare global {
  interface Window {
    Paddle?: PaddleJs
  }
}

let loadPromise: Promise<PaddleJs | null> | null = null

// ── Funnel tracking state ───────────────────────────────────────────────────
// Module-scoped because Paddle.Initialize() takes the callback exactly once,
// while usePaddle() is called per-component. The capture function is re-bound
// on every usePaddle() call so the callback registered during the first
// Initialize keeps working for the whole session.

type Capture = (event: string, properties: Record<string, unknown>) => void

let capture: Capture | null = null

/** Reset per overlay: a close after completion is not an abandonment. */
let hasCompleted = false

function handlePaddleEvent(event: PaddleCheckoutEvent): void {
  if (event.name === 'checkout.completed') hasCompleted = true

  const mapped = resolveCheckoutEvent(event.name, hasCompleted)
  if (!mapped) return

  capture?.(mapped, checkoutEventProperties(event.data))
}

function loadPaddle(
  token: string,
  environment: 'sandbox' | 'production',
): Promise<PaddleJs | null> {
  loadPromise ??= new Promise((resolve) => {
    if (window.Paddle) return resolve(window.Paddle)
    const script = document.createElement('script')
    script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
    script.async = true
    script.onload = () => {
      if (!window.Paddle) return resolve(null)
      // Paddle.js v2: environment is set via Environment.set() BEFORE
      // Initialize — passing it as an Initialize option throws.
      if (environment === 'sandbox') window.Paddle.Environment.set('sandbox')
      window.Paddle.Initialize({ token, eventCallback: handlePaddleEvent })
      resolve(window.Paddle)
    }
    script.onerror = () => resolve(null)
    document.head.appendChild(script)
  })
  return loadPromise
}

export function usePaddle() {
  const config = useRuntimeConfig()
  const { user } = useUserSession()
  const ready = computed(() => Boolean(config.public.paddleClientToken))

  // Bind the dispatcher the (already-registered) Paddle callback fires into.
  // `$posthog` is undefined whenever posthogKey is unset, in which case every
  // checkout event quietly goes nowhere — same as the rest of the analytics.
  const posthog = useNuxtApp().$posthog as
    | { capture: (event: string, properties?: Record<string, unknown>) => void }
    | undefined
  capture = posthog ? (event, properties) => posthog.capture(event, properties) : null

  async function openCheckout(items: PaddleCheckoutItem[] | string, productKey = 'default') {
    const token = config.public.paddleClientToken
    if (!token) {
      console.warn('usePaddle: NUXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set — checkout disabled')
      return false
    }
    const list = typeof items === 'string' ? [{ priceId: items }] : items

    // The funnel's denominator, and deliberately the FIRST thing that happens.
    // `checkout.loaded` comes from Paddle, so it never fires when their script
    // is blocked or slow — counting from it would silently exclude exactly the
    // people who failed to reach a checkout at all.
    capture?.('checkout_started', {
      price_ids: list.map((i) => i.priceId),
      item_count: list.length,
      product_key: productKey,
      signed_in: Boolean(user.value?.id),
    })

    // A fresh overlay: the next close is an abandonment until proven otherwise.
    hasCompleted = false

    const environment = config.public.paddleEnv === 'production' ? 'production' : 'sandbox'
    const paddle = await loadPaddle(token, environment)
    if (!paddle) {
      console.error('usePaddle: failed to load Paddle.js')
      capture?.('checkout_unavailable', { product_key: productKey })
      return false
    }
    paddle.Checkout.open({
      items: list.map((i) => ({ priceId: i.priceId, quantity: i.quantity ?? 1 })),
      ...(user.value?.email ? { customer: { email: user.value.email } } : {}),
      customData: {
        ...(user.value?.id ? { userId: user.value.id } : {}),
        productKey,
      },
      settings: { displayMode: 'overlay' },
    })
    return true
  }

  return { ready, openCheckout }
}
