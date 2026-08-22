// Warm the dev server before either browser suite measures anything.
//
// `nuxt dev` answers Playwright's webServer health check by server-rendering
// one page. The client bundle is a separate, much larger job: Vite transforms
// the component graph on demand when a browser first asks for it, and that
// graph grew substantially when @nuxt/content arrived, because NuxtUI registers
// ~44 Prose* components globally as soon as it is installed.
//
// The symptom was the first `page.goto` of a run — whichever test won the race
// — blowing through Playwright's 30s default while every later navigation took
// two seconds. Raising the per-test timeout for everyone was the wrong fix: it
// triples what a genuine hang costs in each of eighteen tests and blunts the
// one signal that timeout exists to give. Paying the build cost once, here,
// leaves every test on the default budget.
//
// ── Why globalSetup rather than a warmup project ────────────────────────────
// This runs after `webServer` (Playwright starts webServer as a plugin, and
// plugin setup precedes globalSetup), so the server is up by the time it
// navigates. A project would work too, but it would report a test with nothing
// to assert, and every suite would need a `dependencies` entry — one more thing
// to remember when adding the next one.
//
// A real browser rather than `fetch`: fetching the HTML only warms the SSR
// path, and the expensive half is the module graph a browser requests.

import { chromium } from '@playwright/test'
import type { FullConfig } from '@playwright/test'

/** Enough to pull both halves of the graph: the app shell, and rendered markdown. */
const WARM_PATHS = ['/', '/blog/how-billing-works']

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL
  if (!baseURL) return

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ baseURL })
    for (const path of WARM_PATHS) {
      // Failures are not fatal here. This is a performance measure, not a
      // check: if the server is genuinely broken, the suites themselves should
      // be the ones to say so, with a route name and a proper diff.
      await page.goto(path, { timeout: 240_000, waitUntil: 'networkidle' }).catch(() => {})
    }
  } finally {
    await browser.close()
  }
}
