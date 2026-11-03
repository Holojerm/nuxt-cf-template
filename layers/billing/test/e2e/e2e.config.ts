// What billing needs from the shared browser-suite dev server. Read by
// test/e2e/layers.ts, so core's playwright.config.ts never names Paddle.

import type { LayerE2e } from '../../../../test/e2e/layers'
import { E2E_PADDLE_PRICES } from './paddle-prices'
import { PADDLE_TEST_WEBHOOK_SECRET } from './webhook-secret'

export default {
  env: {
    // Only the billing specs call the webhook, but it has to be set on the ONE
    // server every project shares: Playwright has one `webServer` per config.
    // fixtures.ts signs every event with the same constant (see
    // webhook-secret.ts for why it is imported rather than retyped).
    NUXT_PADDLE_WEBHOOK_SECRET: PADDLE_TEST_WEBHOOK_SECRET,
    // The webhook grants only for a configured price, so the ids the fixtures
    // stamp on their events must be the ones this server knows. No client token
    // is set, so /pricing stays disabled — a11y and csp see the same page they
    // always did.
    NUXT_PUBLIC_PADDLE_PRICE_MONTHLY: E2E_PADDLE_PRICES.monthly,
    NUXT_PUBLIC_PADDLE_PRICE_PASS: E2E_PADDLE_PRICES.pass,
  },
  globalSetup: ['./global-setup.ts'],
  globalTeardown: ['./global-teardown.ts'],
} satisfies LayerE2e
