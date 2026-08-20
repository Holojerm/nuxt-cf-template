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

interface PaddleCheckoutItem {
  priceId: string
  quantity?: number
}

interface PaddleJs {
  Initialize(opts: { token: string; environment?: 'sandbox' | 'production' }): void
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
      window.Paddle.Initialize({ token, environment })
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

  async function openCheckout(items: PaddleCheckoutItem[] | string, productKey = 'default') {
    const token = config.public.paddleClientToken
    if (!token) {
      console.warn('usePaddle: NUXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set — checkout disabled')
      return false
    }
    const environment = config.public.paddleEnv === 'production' ? 'production' : 'sandbox'
    const paddle = await loadPaddle(token, environment)
    if (!paddle) {
      console.error('usePaddle: failed to load Paddle.js')
      return false
    }
    const list = typeof items === 'string' ? [{ priceId: items }] : items
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
