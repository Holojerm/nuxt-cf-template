// Warm the dev server before the real suites measure anything.
//
// `nuxt dev` answers Playwright's webServer health check by server-rendering
// one page. The client bundle is a separate, much larger job: Vite transforms
// the whole component graph on demand when a browser first asks for it, and
// that graph got substantially bigger when @nuxt/content arrived, because
// NuxtUI registers ~44 Prose* components globally as soon as it is installed.
//
// The result was the first `page.goto` of a run — whichever test happened to
// win the race — blowing through Playwright's 30s default while every later
// navigation took two seconds. Raising the per-test timeout for everyone was
// the wrong fix: it makes a genuine hang cost 90s in each of eighteen tests
// instead of 30s, and it hides exactly the regression the timeout exists to
// catch. Paying the build cost once, here, in a test that is allowed to be
// slow, leaves every other test on the default budget.
//
// Registered as a project dependency (playwright.config.ts), so both the a11y
// and CSP projects wait for it rather than racing it.

import { test } from '@playwright/test'

// The cold path is a full client build, and CI is always cold. This budget is
// for that build, not for a page load.
test.setTimeout(240_000)

test('warm the client bundle', async ({ page }) => {
  // `/` pulls the app entry, the default layout, and the landing page.
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // A post pulls ContentRenderer and the Prose components, which is the half of
  // the graph the landing page never touches.
  await page.goto('/blog/how-billing-works')
  await page.waitForLoadState('networkidle')
})
