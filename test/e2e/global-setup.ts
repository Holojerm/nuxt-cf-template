// Warm the one API route test/e2e/fixtures.ts races against a clock.
//
// ── Why this exists ──────────────────────────────────────────────────────
// Nitro's dev server compiles each route handler lazily, on its first hit, and
// the Playwright projects (a11y, csp, e2e, and each layer's e2e) share one
// single-threaded dev server with `retries: 0`. A cold compile of
// /api/auth/dev, which every signed-in spec calls first, can eat a slow run's
// whole budget and read exactly like a real failure. Hitting it once, here,
// before any timed assertion runs, pays that cost outside the window that
// matters. A layer with a route of its own to warm adds a global-setup.ts to
// its test/e2e/ (see test/e2e/layers.ts); billing warms its webhook that way.
//
// ── Why a sibling to test/warmup/global-setup.ts, not folded into it ────────
// That file warms the CLIENT bundle via a real page navigation — an
// unrelated concern (the module graph a browser requests) from this API
// route. playwright.config.ts's `globalSetup` accepts an array of paths
// precisely so independent warm-ups don't have to become one file that does
// unrelated things.
//
// ── Why the request need not succeed ────────────────────────────────────────
// This is a performance measure, not a check — same reasoning as
// test/warmup/global-setup.ts's own "failures are not fatal here". If the
// server is genuinely broken, the real timed specs are what should say so,
// with a route name and a proper diff.
//
// /api/auth/dev is hit with a real, throwaway address on the same `e2e-` prefix
// every fixture in this suite uses, so the full establishSession() path
// compiles too, not just its validation branch — and it's swept up by
// test/e2e/global-teardown.ts like every other e2e-* row instead of
// accumulating.

import { request } from '@playwright/test'
import type { FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return

  const context = await request.newContext({ baseURL })
  try {
    await context
      .post('/api/auth/dev', {
        data: { email: 'e2e-warmup@example.com', name: 'E2E Warmup' },
      })
      .catch(() => {})
  } finally {
    await context.dispose()
  }
}
