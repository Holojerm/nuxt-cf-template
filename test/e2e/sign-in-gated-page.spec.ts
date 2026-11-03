// Spec 1 — sign in → gated page.
//
// The front half of the funnel nothing had ever run in a real browser
// (Findings 18 + 20): a signed-out visit to a gated route bounces to /login
// with a way back. The half that needs a plan is billing's own spec,
// layers/billing/test/e2e/gated-without-plan.spec.ts.

import { expect, test } from './fixtures'

test('a signed-out visit to the gated page redirects to /login with a way back', async ({
  page,
}) => {
  await page.goto('/dashboard')
  await page.waitForURL(/\/login/)

  const url = new URL(page.url())
  expect(url.pathname).toBe('/login')
  expect(url.searchParams.get('redirect')).toBe('/dashboard')
})
