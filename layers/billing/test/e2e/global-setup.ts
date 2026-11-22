// Start the Stripe stub, and warm /stripe/webhook.
//
// The stub (stripe-stub.ts) is what the dev server's NUXT_STRIPE_API_BASE points
// at, so the webhook's lookups never leave the machine. It has to be up before
// any spec runs; this file is where the runner process starts it.
//
// Nitro's dev server compiles each route handler lazily, on its first hit, and
// the Playwright projects share one single-threaded dev server with
// `retries: 0`. A cold compile of the webhook route (and its imports:
// entitlements, referral, notifications) can eat a slow run's whole timeout
// budget and read like a real failure, so it is hit once here. The request has
// no `stripe-signature` header, which is refused instantly with a 401 before any
// clock is read. It need not succeed: this is a performance measure, not a check.

import { request } from '@playwright/test'
import type { FullConfig } from '@playwright/test'

import { startStripeStub } from './stripe-stub'

export default async function globalSetup(config: FullConfig): Promise<void> {
  await startStripeStub()

  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return

  const context = await request.newContext({ baseURL })
  try {
    await context
      .post('/stripe/webhook', {
        data: '{}',
        headers: { 'content-type': 'application/json' },
      })
      .catch(() => {})
  } finally {
    await context.dispose()
  }
}
