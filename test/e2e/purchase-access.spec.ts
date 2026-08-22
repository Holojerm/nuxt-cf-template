// Spec 2 — buy → access.
//
// Drives a real purchase through the real money path: sign in, POST a signed
// Paddle webhook exactly as Paddle would deliver it, and prove the dashboard
// unlocks and GET /api/billing/entitlement agrees. Two variants, because the
// entitlements table tells a pass and a subscription apart by the ref's
// prefix (server/utils/paddle-refs.ts) and the two exercise different code in
// applyPaddleEvent (grantPass vs. upsertSubscription) — see
// server/utils/entitlements.ts.
//
// Each variant signs in as its own fresh user rather than sharing one, on
// purpose: findActiveEntitlement grants access from ANY row in
// ACTIVE_STATUSES for the account, so a pass and a subscription live on the
// same user would make it impossible to tell which purchase actually unlocked
// the page.

import {
  DAY_MS,
  expect,
  expectWebhookAccepted,
  subscriptionEvent,
  test,
  transactionCompletedEvent,
  uniqueEmail,
  uniquePaddleRef,
  watchForViolations,
} from './fixtures'

test.describe('buy → access', () => {
  test('a one-time pass purchase unlocks the dashboard', async ({ signInAs, sendPaddleEvent }) => {
    const email = uniqueEmail('buy-pass')
    const { userId, page, context } = await signInAs(email, 'Pass Buyer')
    const violations = watchForViolations(page)

    const transactionId = uniquePaddleRef('txn_', 'buy-pass')
    const response = await sendPaddleEvent(transactionCompletedEvent({ userId, transactionId }))
    await expectWebhookAccepted(response)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible()
    // The onboarding checklist (app/components/Onboarding/Checklist.vue) —
    // proof this is the real dashboard content, not an empty shell that
    // happened not to redirect.
    await expect(page.getByText('Get set up')).toBeVisible()

    const entitlement = await context.request.get('/api/billing/entitlement')
    expect(entitlement.ok()).toBe(true)
    const body = (await entitlement.json()) as { active: boolean; kind: string | null }
    expect(body.active).toBe(true)
    expect(body.kind).toBe('pass')

    // Also sweeps /account — the other signed-in page a console/CSP
    // regression could hide on (see CLAUDE.md's a11y/CSP suites, which only
    // ever scan signed-out routes).
    // The full sentence, not the fragment 'One-time pass' — the Plan card
    // also has a `dt`/`dd` pair spelling out the type, and getByText's
    // case-insensitive substring match hits both.
    await page.goto('/account')
    await expect(page.getByText('You have a one-time pass. It will not renew.')).toBeVisible()

    await violations.assertClean()
  })

  test('a subscription activation unlocks the dashboard', async ({ signInAs, sendPaddleEvent }) => {
    const email = uniqueEmail('buy-subscription')
    const { userId, page, context } = await signInAs(email, 'Subscriber')
    const violations = watchForViolations(page)

    const subscriptionId = uniquePaddleRef('sub_', 'buy-subscription')
    const response = await sendPaddleEvent(
      subscriptionEvent({
        eventType: 'subscription.activated',
        userId,
        subscriptionId,
        status: 'active',
        currentPeriodEndsAt: new Date(Date.now() + 30 * DAY_MS),
      }),
    )
    await expectWebhookAccepted(response)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible()

    const entitlement = await context.request.get('/api/billing/entitlement')
    expect(entitlement.ok()).toBe(true)
    const body = (await entitlement.json()) as { active: boolean; kind: string | null }
    expect(body.active).toBe(true)
    expect(body.kind).toBe('subscription')

    await page.goto('/account')
    await expect(page.getByText('Your subscription renews automatically.')).toBeVisible()

    await violations.assertClean()
  })
})
