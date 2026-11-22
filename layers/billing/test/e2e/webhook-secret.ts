// Values two consumers must agree on: e2e.config.ts hands them to the dev
// server it spawns (NUXT_STRIPE_WEBHOOK_SECRET, NUXT_STRIPE_SECRET_KEY), and
// fixtures.ts signs every webhook with the same secret. A literal copied into
// both places is the kind of pair that drifts, so each is one constant,
// imported twice.
//
// Not secrets in the security sense: they exist only for one suite run, belong
// to no Stripe account, and the key only ever reaches the local stub
// (stripe-stub.ts).
export const STRIPE_TEST_WEBHOOK_SECRET = 'whsec_e2e_test_secret'
export const E2E_STRIPE_SECRET_KEY = 'sk_test_e2e_dummy_key'
