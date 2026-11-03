// Warm /paddle/webhook, the route layers/billing/test/e2e/fixtures.ts races
// against a clock.
//
// layers/billing/server/utils/paddle.ts verifies a Paddle webhook's `ts` against
// a 5-second tolerance — production's value, left alone here (see
// signPaddleWebhook's timing contract in fixtures.ts). Nitro's dev server
// compiles each route handler lazily, on its first hit, and the Playwright
// projects share one single-threaded dev server with `retries: 0`. A cold
// compile of the route can easily eat that whole 5-second budget on a slow run,
// and layers/billing/server/routes/paddle/webhook.post.ts collapses every
// rejection reason (stale timestamp, bad signature, malformed header) into the
// same 401 "Invalid signature", so a compile-time flake reads exactly like a
// real HMAC bug.
//
// It is hit with NO `paddle-signature` header at all, which paddle.ts rejects
// before it ever reads a clock: a deterministic, instant 401 that still pulls
// the whole route module (and its imports: entitlements, referral,
// notifications) through Nitro's compiler. Neither request needs to succeed;
// this is a performance measure, not a check.

import { request } from '@playwright/test'
import type { FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return

  const context = await request.newContext({ baseURL })
  try {
    await context
      .post('/paddle/webhook', {
        data: '{}',
        headers: { 'content-type': 'application/json' },
      })
      .catch(() => {})
  } finally {
    await context.dispose()
  }
}
