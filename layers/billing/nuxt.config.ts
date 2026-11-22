// The billing layer: Stripe Managed Payments (Stripe, as Link, is the merchant
// of record). Hosted Checkout (POST /api/billing/checkout), the webhook
// (POST /stripe/webhook), signature check, idempotent event handling, the
// entitlements and billing_events tables, the access check (requireSubscription,
// registered as core's `requireAccess` gate), billing state and the past-due
// UI, useCheckout()/useEntitlement(), the /pricing scaffold, billing emails'
// decisions, comp grants, and its contributions to core
// (layers/billing/server/plugins/billing.ts → layers/billing/server/utils/billing-extensions.ts).
//
// What the app supplies:
//   - price ids and the Stripe product id (below), as NUXT_* env vars;
//   - plan copy and amounts: shadow layers/billing/app/utils/plans.ts, or layers/billing/app/pages/pricing.vue
//     for a bespoke page. Both are client files, so an app copy wins over this one;
//   - entitlement-grant rules beyond the shipped ones, through
//     registerBillingOutcomeHandler() (core's server/utils/billing-outcome.ts).
// A layer's server/utils export always wins over an app file at the same path
// and cannot be shadowed: a fork whose own util collides (a `billing.ts`, an
// `entitlements.ts`) must rename it before vendoring this layer.
//
// Expects core's server utils (extensions, access-gate, lifecycle, purge, ops,
// posthog, email), the `users` table and `db`, and the auth session. The
// referral loop (an app's own feature, or a layer) reacts to money through
// core's outcome-handler, view-field and earned-access seams and never imports
// this layer. Auto-registered because it lives under layers/.
//
// ── Every key below is a deployed env var name ─────────────────────────────
// Nuxt only applies NUXT_* overrides to keys declared in runtimeConfig, so these
// declarations ARE the env contract: NUXT_STRIPE_SECRET_KEY,
// NUXT_STRIPE_WEBHOOK_SECRET, NUXT_STRIPE_PRODUCT_ID,
// NUXT_PUBLIC_STRIPE_PRICE_PASS and NUXT_PUBLIC_STRIPE_PRICE_MONTHLY. Renaming
// one orphans a live secret.
export default defineNuxtConfig({
  $meta: { name: 'billing' },
  runtimeConfig: {
    // Stripe billing (test mode first), set via NUXT_STRIPE_* env vars / secrets
    stripe: {
      // Secret or restricted API key (sk_… / rk_…). Required once billing is
      // on: checkout, the cancel button and the webhook's lookups all use it.
      // A test-mode key and a live key are different accounts' worth of data:
      // the key decides the mode, there is no separate environment switch.
      secretKey: '',
      // Signing secret (whsec_…) of the webhook endpoint, from Stripe ›
      // Developers › Webhooks
      webhookSecret: '',
      // The Stripe product (prod_…) this app sells. Optional. One Stripe
      // account sells several apps and every endpoint receives every event;
      // with this set, an event whose items are all on another product is
      // logged as `stripe_webhook_foreign_product` instead of raising an
      // "unrecognised price" ops alert. A wrangler var, not a secret.
      productId: '',
      // Stripe API host override (NUXT_STRIPE_API_BASE). Empty = Stripe's own
      // host. Only the replay script and tests set it, to point the client at
      // a stub: the key is sent wherever this points.
      apiBase: '',
    },
    // Options for apps; defaults are the template's behaviour.
    billing: {
      // Days of access one pass buys (and one comp pass grants). Applied at
      // startup by layers/billing/server/plugins/billing.ts.
      passDays: 30,
      // Ops-alert when a refund or chargeback names a transaction no entitlement
      // exists for ("money went back out for something we never granted").
      // Right for an app with its own Stripe account. Turn it off for an app
      // that shares an account with another: adjustment events carry no product
      // id, so neither app can tell the other's refunds from its own, and every
      // foreign refund would page this one. The warn log line stays either way.
      alertUnmatchedAdjustments: true,
      // Refuse account deletion (409 `live_subscription`) while a subscription
      // can still bill. Turn it off only when the app's own deletion flow
      // cancels the subscription at Stripe itself and fails closed.
      guardDeletion: true,
      // Cancel the person's live subscription at Stripe, immediately, when they
      // delete their account, rather than refusing until they cancel in the
      // portal. Fails closed: if Stripe will not confirm, nothing is deleted and
      // the 409 is returned. A restricted key needs Subscriptions: write. Replaces
      // the guard (guardDeletion is then moot).
      cancelOnDeletion: false,
      // The 409 `data.code` for a deletion refused over a live subscription.
      // The template's account page reads `live_subscription`; an app with its
      // own client changes it.
      deletionRefusalCode: 'live_subscription',
      // Send the customer emails billing decides on (purchase, payment failed,
      // access ended, comp granted and revoked). Turn it off for an app that
      // sends no customer email: nothing is looked up, rendered, sent or logged.
      // Core's email modules must still exist (the layer imports them); the
      // `pass_expiring` lifecycle step is sent only by core's lifecycle task.
      notify: true,
      // Send the layer's own `billing_*` PostHog events from the webhook
      // (subscription lifecycle, transaction completed, access revoked). Turn it
      // off for an app that records its own plan events through
      // registerBillingOutcomeHandler() and promises its users nothing more.
      analytics: true,
      // Stack a new pass on the access running when it was bought, not when the
      // webhook was processed. Only differs when delivery lagged past the old
      // pass's end; true keeps the customer's overlap. Default: the wall clock.
      stackAtBilledAt: false,
    },
    public: {
      // Stripe price IDs (price_…) for the plans on /pricing. Kept in config
      // rather than in layers/billing/app/utils/plans.ts so test mode and live mode can point at
      // different prices without a code change. Empty = that plan's button is
      // disabled instead of opening a checkout that 400s. Each price's product
      // needs a tax code Managed Payments accepts (SaaS, personal use).
      stripePriceMonthly: '',
      stripePricePass: '',
    },
  },
})
