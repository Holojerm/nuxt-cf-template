// Spec 1 — sign in → gated page.
//
// The front half of the funnel nothing had ever run in a real browser
// (Findings 18 + 20): a signed-out visit to a gated route bounces to /login
// with a way back, POST /api/auth/dev establishes a real session cookie the
// server actually accepts, and a signed-in user with NO entitlement is turned
// away from /dashboard by app/middleware/subscription.ts — landing on the
// specific alert /pricing shows for exactly that case.

import { expect, test, uniqueEmail, watchForViolations } from './fixtures'

test('a signed-out visit to the gated page redirects to /login with a way back', async ({
  page,
}) => {
  await page.goto('/dashboard')
  await page.waitForURL(/\/login/)

  const url = new URL(page.url())
  expect(url.pathname).toBe('/login')
  expect(url.searchParams.get('redirect')).toBe('/dashboard')
})

test('a signed-in user with no entitlement is turned away from /dashboard, and the reason is on screen', async ({
  signInAs,
}) => {
  const email = uniqueEmail('gated-no-entitlement')
  const { page, context } = await signInAs(email, 'Gated Visitor')
  // This flow drives exactly one gated redirect (dashboard -> pricing) through
  // app/middleware/subscription.ts's known SSR bug — see
  // KNOWN_HYDRATION_MISMATCH in ./fixtures.ts. Goes to 0 once that's fixed.
  const violations = watchForViolations(page, { expectedHydrationMismatches: 1 })

  await page.goto('/dashboard')
  await page.waitForURL(/\/pricing/)

  const url = new URL(page.url())
  expect(url.pathname).toBe('/pricing')
  expect(url.searchParams.get('from')).toBe('/dashboard')

  // app/pages/pricing.vue's `gatedFrom` branch — the alert that exists so
  // "why am I here?" has an answer instead of a plans page appearing out of
  // nowhere.
  await expect(page.getByText('That page needs an active plan')).toBeVisible()

  // The session guard (server/middleware/auth.ts) actually accepted the
  // cookie the dev endpoint set — not just that the client THINKS it's
  // signed in. /api/_auth/session is the one endpoint nuxt-auth-utils' own
  // useUserSession() reads, so this is the same check the app relies on.
  const session = await context.request.get('/api/_auth/session')
  expect(session.ok()).toBe(true)
  const sessionBody = (await session.json()) as { user?: { email?: string } }
  expect(sessionBody.user?.email).toBe(email)

  await violations.assertClean()
})
