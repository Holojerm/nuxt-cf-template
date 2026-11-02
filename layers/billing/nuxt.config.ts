// The billing layer: Paddle as merchant of record. The webhook
// (POST /paddle/webhook), signature check, idempotent event handling, the
// entitlements and paddle_events tables, the access check (requireSubscription,
// registered as core's `requireAccess` gate), billing state and the past-due
// UI, usePaddle()/useEntitlement(), the /pricing scaffold, billing emails'
// decisions, comp grants, and its contributions to core
// (layers/billing/server/plugins/billing.ts → layers/billing/server/utils/billing-extensions.ts).
//
// What the app supplies:
//   - price ids and the Paddle product id (below), as NUXT_* env vars;
//   - plan copy and amounts: shadow layers/billing/app/utils/plans.ts, or layers/billing/app/pages/pricing.vue
//     for a bespoke page. Both are client files, so an app copy wins over this one;
//   - the Paddle hosts in its Content-Security-Policy (nuxt.config.ts › CSP);
//   - entitlement-grant rules beyond the shipped ones, through
//     registerBillingOutcomeHandler() (server/utils/billing-outcome.ts).
// A layer's server/utils export always wins over an app file at the same path
// and cannot be shadowed: a fork whose own util collides (a `billing.ts`, an
// `entitlements.ts`) must rename it before vendoring this layer.
//
// Expects core's server utils (extensions, access-gate, lifecycle, purge, ops,
// posthog, email), the `users` table and `db`, and the auth session. Referral
// stays in core and registers itself as an outcome handler. Auto-registered
// because it lives under layers/.
//
// ── Every key below is a deployed env var name ─────────────────────────────
// Nuxt only applies NUXT_* overrides to keys declared in runtimeConfig, so these
// declarations ARE the env contract: NUXT_PADDLE_WEBHOOK_SECRET,
// NUXT_PADDLE_API_KEY, NUXT_PADDLE_PRODUCT_ID, NUXT_PUBLIC_PADDLE_CLIENT_TOKEN,
// NUXT_PUBLIC_PADDLE_ENV, NUXT_PUBLIC_PADDLE_PRICE_PASS and
// NUXT_PUBLIC_PADDLE_PRICE_MONTHLY. Renaming one orphans a live secret.
export default defineNuxtConfig({
  $meta: { name: 'billing' },
  runtimeConfig: {
    // Paddle billing (sandbox-first) — set via NUXT_PADDLE_* env vars / secrets
    paddle: {
      // Endpoint secret from Paddle → Developer tools → Notifications
      webhookSecret: '',
      // Server-side API key (required once billing is on: the cancel button
      // opens a portal session through it)
      apiKey: '',
      // The Paddle product (pro_…) this app sells. Optional. A Paddle account
      // that sells several apps sends every app's events to every webhook
      // destination; with this set, an event whose items are all on another
      // product is logged as `paddle_webhook_foreign_product` instead of
      // raising an "unrecognised price" ops alert. A wrangler var, not a secret.
      productId: '',
    },
    // Options for apps; defaults are the template's behaviour.
    billing: {
      // Days of access one pass buys (and one comp pass grants). Applied at
      // startup by layers/billing/server/plugins/billing.ts.
      passDays: 30,
      // Ops-alert when a refund or chargeback names a transaction no entitlement
      // exists for ("money went back out for something we never granted").
      // Right for an app with its own Paddle account. Turn it off for an app
      // that shares an account with another: adjustment events carry no product
      // id, so neither app can tell the other's refunds from its own, and every
      // foreign refund would page this one. The warn log line stays either way.
      alertUnmatchedAdjustments: true,
      // Refuse account deletion (409 `live_subscription`) while a subscription
      // can still bill. Turn it off only when the app's own deletion flow
      // cancels the subscription at Paddle itself and fails closed.
      guardDeletion: true,
    },
    public: {
      // Paddle client-side token (public by design) + environment. Empty
      // token = usePaddle() no-ops, so the template runs without a Paddle account.
      paddleClientToken: '',
      paddleEnv: 'sandbox',
      // Paddle price IDs (pri_…) for the plans on /pricing. Kept in config
      // rather than in layers/billing/app/utils/plans.ts so sandbox and production can point at
      // different prices without a code change. Empty = that plan's button is
      // disabled instead of opening a checkout that 400s.
      paddlePriceMonthly: '',
      paddlePricePass: '',
    },
  },
})
