// Spec 3 — cancel → lose access.
//
// The mirror image of Spec 2: a subscription that was genuinely granting
// access stops, through the same real webhook path a Paddle cancellation
// takes, and every surface that promises access has to agree it's gone —
// the gate (app/middleware/subscription.ts), the account page, and
// GET /api/billing/entitlement. Plus the case that isn't a cancellation at
// all: a failed payment (`past_due`), which server/utils/billing-state.ts
// treats as recoverable dunning rather than an ended plan, and which
// subscription.ts routes to /account (where the fix — update the card —
// lives) instead of /pricing (where it would look like re-selling something
// already being paid for).
//
// Each case signs in as its own fresh user and buys its own subscription
// first, rather than reusing one from purchase-access.spec.ts: Playwright
// runs spec files across workers with no ordering guarantee, so the only
// dependable way to reach "a subscription that was granting access" is to
// put it there in this file, through the same buy step Spec 2 proves works.

import {
  DAY_MS,
  expect,
  expectWebhookAccepted,
  subscriptionEvent,
  test,
  uniqueEmail,
  uniquePaddleRef,
  watchForViolations,
} from './fixtures'

test.describe('cancel → lose access', () => {
  test('canceling a subscription revokes dashboard access', async ({
    signInAs,
    sendPaddleEvent,
  }) => {
    const email = uniqueEmail('cancel-subscription')
    const { userId, page, context } = await signInAs(email, 'Canceling Subscriber')
    const violations = watchForViolations(page)

    const subscriptionId = uniquePaddleRef('sub_', 'cancel-subscription')
    await expectWebhookAccepted(
      await sendPaddleEvent(
        subscriptionEvent({
          eventType: 'subscription.activated',
          userId,
          subscriptionId,
          status: 'active',
          currentPeriodEndsAt: new Date(Date.now() + 30 * DAY_MS),
        }),
      ),
    )

    // Access really was granted before it's taken away — otherwise a
    // passing redirect assertion below could just mean the buy step silently
    // failed rather than that the cancellation worked.
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)

    await expectWebhookAccepted(
      await sendPaddleEvent(
        subscriptionEvent({
          eventType: 'subscription.canceled',
          userId,
          subscriptionId,
          status: 'canceled',
          currentPeriodEndsAt: new Date(),
        }),
      ),
    )

    await page.goto('/dashboard')
    await page.waitForURL(/\/pricing/)
    const url = new URL(page.url())
    expect(url.pathname).toBe('/pricing')
    expect(url.searchParams.get('from')).toBe('/dashboard')

    await page.goto('/account')
    await expect(page.getByText("You don't have an active plan.")).toBeVisible()

    const entitlement = await context.request.get('/api/billing/entitlement')
    const body = (await entitlement.json()) as { active: boolean; state: string }
    expect(body.active).toBe(false)
    expect(body.state).toBe('inactive')

    await violations.assertClean()
  })

  test('a past_due subscription routes the gated page to /account, not /pricing', async ({
    signInAs,
    sendPaddleEvent,
  }) => {
    const email = uniqueEmail('past-due-subscription')
    const { userId, page, context } = await signInAs(email, 'Dunning Subscriber')
    const violations = watchForViolations(page)

    const subscriptionId = uniquePaddleRef('sub_', 'past-due-subscription')
    await expectWebhookAccepted(
      await sendPaddleEvent(
        subscriptionEvent({
          eventType: 'subscription.activated',
          userId,
          subscriptionId,
          status: 'active',
          currentPeriodEndsAt: new Date(Date.now() + 30 * DAY_MS),
        }),
      ),
    )

    await expectWebhookAccepted(
      await sendPaddleEvent(
        subscriptionEvent({
          eventType: 'subscription.updated',
          userId,
          subscriptionId,
          status: 'past_due',
          currentPeriodEndsAt: new Date(),
        }),
      ),
    )

    await page.goto('/dashboard')
    // Not /pricing: app/middleware/subscription.ts sends a past_due account
    // to /account specifically, because /pricing would read as "buy the
    // thing you're already paying for" to someone mid-dunning.
    await page.waitForURL(/\/account/)
    const url = new URL(page.url())
    expect(url.pathname).toBe('/account')
    expect(url.searchParams.get('from')).toBe('/dashboard')

    // app/components/Billing/PastDueAlert.vue — shared between the layout
    // banner and this page specifically so the two can't tell two different
    // stories about the same failed payment.
    await expect(page.getByText("Your last payment didn't go through")).toBeVisible()

    const entitlement = await context.request.get('/api/billing/entitlement')
    const body = (await entitlement.json()) as { active: boolean; state: string }
    expect(body.active).toBe(false)
    expect(body.state).toBe('past_due')

    await violations.assertClean()
  })
})
