// What billing needs from the shared browser-suite dev server. Read by
// test/e2e/layers.ts, so core's playwright.config.ts never names Stripe.

import type { LayerE2e } from '../../../../test/e2e/layers'
import { E2E_STRIPE_PRICES } from './stripe-prices'
import { stripeStubUrl } from './stripe-stub'
import { E2E_STRIPE_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET } from './webhook-secret'

export default {
  env: {
    // Only the billing specs call the webhook, but it has to be set on the ONE
    // server every project shares: Playwright has one `webServer` per config.
    // fixtures.ts signs every event with the same constant (see
    // webhook-secret.ts for why it is imported rather than retyped).
    NUXT_STRIPE_WEBHOOK_SECRET: STRIPE_TEST_WEBHOOK_SECRET,
    // The webhook refuses to run without a key, because a pass purchase and a
    // refund need a lookup at Stripe. The lookups go to the stub started in
    // global-setup.ts, never to api.stripe.com.
    NUXT_STRIPE_SECRET_KEY: E2E_STRIPE_SECRET_KEY,
    NUXT_STRIPE_API_BASE: stripeStubUrl(),
    // The webhook grants only for a configured price, so the ids the fixtures
    // stamp on their events must be the ones this server knows. Configured
    // prices also enable the buy buttons on /pricing, which only a click could
    // turn into a call to Stripe, and none of the suites clicks them.
    NUXT_PUBLIC_STRIPE_PRICE_MONTHLY: E2E_STRIPE_PRICES.monthly,
    NUXT_PUBLIC_STRIPE_PRICE_PASS: E2E_STRIPE_PRICES.pass,
  },
  globalSetup: ['./global-setup.ts'],
  globalTeardown: ['./global-teardown.ts'],
} satisfies LayerE2e
