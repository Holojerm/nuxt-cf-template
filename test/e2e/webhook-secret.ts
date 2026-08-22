// One value, two consumers that must agree: playwright.config.ts hands this to
// the dev server it spawns (as NUXT_PADDLE_WEBHOOK_SECRET), and
// test/e2e/fixtures.ts signs every webhook it sends with the same value. A
// literal string copied into both places is exactly the kind of pair that
// drifts — see NATIVE_LIMITER in server/utils/rate-limit.ts for the general
// shape of this mistake, and why this repo prefers one constant, imported
// twice, over two constants that happen to agree today.
//
// Not a secret in the security sense: it exists only for the lifetime of one
// `bun run ci` invocation, is never used against a real Paddle account, and
// signs nothing outside this checkout's own dev server.
export const PADDLE_TEST_WEBHOOK_SECRET = 'e2e-test-secret'
