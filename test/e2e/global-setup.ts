// Warm the two API routes test/e2e/fixtures.ts races against a clock.
//
// ── Why this exists ──────────────────────────────────────────────────────
// server/utils/paddle.ts verifies a Paddle webhook's `ts` against a 5-second
// tolerance — production's value, left alone here (see
// signPaddleWebhook's timing contract in fixtures.ts). Nitro's dev server
// compiles each route handler lazily, on its first hit, and the three
// Playwright projects (a11y, csp, e2e) share one single-threaded dev server
// with `retries: 0`. A cold compile of /paddle/webhook or /api/auth/dev can
// easily eat that whole 5-second budget on a slow run — and
// server/routes/paddle/webhook.post.ts collapses every rejection reason
// (stale timestamp, bad signature, malformed header) into the same 401
// "Invalid signature", so a compile-time flake reads exactly like a real
// HMAC bug. Hitting both routes once, here, before any timed assertion runs,
// pays that cost outside the window that matters.
//
// ── Why a sibling to test/warmup/global-setup.ts, not folded into it ────────
// That file warms the CLIENT bundle via a real page navigation — an
// unrelated concern (the module graph a browser requests) from these two
// specific API routes. playwright.config.ts's `globalSetup` accepts an
// array of paths precisely so two independent warm-ups don't have to become
// one file that does two unrelated things.
//
// ── Why neither request needs to succeed ────────────────────────────────────
// This is a performance measure, not a check — same reasoning as
// test/warmup/global-setup.ts's own "failures are not fatal here". If the
// server is genuinely broken, the real timed specs are what should say so,
// with a route name and a proper diff.
//
// /paddle/webhook is hit with NO `paddle-signature` header at all, which
// server/utils/paddle.ts rejects before it ever reads a clock — a
// deterministic, instant 401 that still pulls the whole route module (and
// its imports: entitlements, referral, notifications) through Nitro's
// compiler. /api/auth/dev is hit with a real, throwaway address on the same
// `e2e-` prefix every fixture in this suite uses, so the full
// establishSession() path compiles too, not just its validation branch —
// and it's swept up by test/e2e/global-teardown.ts like every other e2e-*
// row instead of accumulating.

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

    await context
      .post('/api/auth/dev', {
        data: { email: 'e2e-warmup@example.com', name: 'E2E Warmup' },
      })
      .catch(() => {})
  } finally {
    await context.dispose()
  }
}
