// Spec 1b — a signed-in account with no plan is turned away from the gated page.
//
// POST /api/auth/dev establishes a real session cookie the server actually
// accepts, and a signed-in user with NO entitlement is turned away from
// /dashboard by layers/billing/app/middleware/subscription.ts — landing on the
// specific alert /pricing shows for exactly that case. The signed-out half of
// this flow is test/e2e/sign-in-gated-page.spec.ts.

import {
  billingE2e,
  expect,
  expectAccess,
  expectBounced,
  test,
  uniqueEmail,
  watchForViolations,
} from './fixtures'

test('a signed-in user with no entitlement is turned away from /dashboard, and the reason is on screen', async ({
  signInAs,
}) => {
  const email = uniqueEmail('gated-no-entitlement')
  const { page, context } = await signInAs(email, 'Gated Visitor')
  const violations = watchForViolations(page)

  // Page-level half: skipped when the fork has no gated page (fork-config.ts).
  if (billingE2e.gatedPath) {
    await expectBounced(page, billingE2e.upsellPathPrefix)

    // layers/billing/app/pages/pricing.vue's `gatedFrom` branch — the alert that exists so
    // "why am I here?" has an answer instead of a plans page appearing out of
    // nowhere.
    await expect(page.getByText(billingE2e.gatedCopy)).toBeVisible()
  } else {
    await page.goto('/')
  }

  // Entitlement half, always: no plan means inactive.
  const entitlement = await context.request.get('/api/billing/entitlement')
  expect(entitlement.ok()).toBe(true)
  expect(((await entitlement.json()) as { active: boolean }).active).toBe(false)
  await expectAccess({ page, request: context.request }, 'denied')

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
