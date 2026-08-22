// The status matrix behind every dunning surface in the app.
//
// It is one small function, but it is the function that decides whether a
// customer is told "your payment failed, here's the fix" or "you don't have a
// plan, would you like to buy one" — so the whole table is enumerated rather
// than spot-checked. The `past_due` rows in particular have to keep agreeing
// with ACTIVE_STATUSES in server/utils/entitlements.ts, which excludes
// past_due: if that ever changes, these expectations are where it should hurt.

import { describe, expect, it } from 'vitest'
import { PAST_DUE_STALE_AFTER_DAYS, deriveBillingState } from '../server/utils/billing-state'
import type { BillingStateRow } from '../server/utils/billing-state'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-01T12:00:00.000Z')
/** A period end `days` from NOW; negative is in the past. */
const endingIn = (days: number) => new Date(NOW.getTime() + days * DAY_MS)

/** Always at the same instant — every expectation here is clock-relative. */
const derive = (
  granting: BillingStateRow | null,
  history: readonly BillingStateRow[],
  now: Date = NOW,
) => deriveBillingState(granting, history, now)

const sub = (status: string, id = 'sub_1', currentPeriodEnd = endingIn(20)): BillingStateRow => ({
  paddleSubscriptionId: id,
  status,
  currentPeriodEnd,
})
const pass = (status = 'active', id = 'txn_1', currentPeriodEnd = endingIn(20)): BillingStateRow => ({
  paddleSubscriptionId: id,
  status,
  currentPeriodEnd,
})

describe('deriveBillingState — access granted', () => {
  it('reports active for a granting subscription', () => {
    expect(derive(sub('active'), [sub('active')])).toBe('active')
  })

  it('reports trialing separately, because the copy differs', () => {
    expect(derive(sub('trialing'), [sub('trialing')])).toBe('trialing')
  })

  it('reports active for an unexpired one-time pass', () => {
    // A pass has no lifecycle status of its own — findActiveEntitlement decided
    // it still grants by date, and that is all this function needs to know.
    expect(derive(pass(), [pass()])).toBe('active')
  })
})

describe('deriveBillingState — dunning', () => {
  it('reports past_due when a subscription payment failed', () => {
    expect(derive(null, [sub('past_due')])).toBe('past_due')
  })

  it('finds the past_due row behind older ended ones', () => {
    const history = [sub('past_due', 'sub_2'), sub('canceled', 'sub_1'), pass('active', 'txn_old')]
    expect(derive(null, history)).toBe('past_due')
  })

  it('lets a live pass outrank a past_due subscription', () => {
    // Access is genuinely still granted, so "your access is paused" would be a
    // lie. The dunning state surfaces when the pass expires.
    const history = [pass(), sub('past_due')]
    expect(derive(pass(), history)).toBe('active')
  })

  it('never reads past_due off a pass row', () => {
    // Paddle emits no subscription lifecycle for a `txn_`, so this shouldn't
    // exist — but a state machine that trusts its inputs is one bad webhook
    // away from telling someone to update a card they never saved.
    expect(derive(null, [pass('past_due')])).toBe('inactive')
  })

  it('never reads past_due off a comped row', () => {
    // A `comp_` grant (server/utils/admin-grants.ts) has no card behind it at
    // all. Reading one as dunning would tell someone to fix a payment method
    // for access support handed them for free — an invented problem, and a
    // support conversation about a charge that never happened.
    const comp: BillingStateRow = {
      paddleSubscriptionId: 'comp_x',
      status: 'past_due',
      currentPeriodEnd: endingIn(5),
    }
    expect(derive(null, [comp])).toBe('inactive')
  })
})

describe('deriveBillingState — dunning has a shelf life', () => {
  // A `sub_` row leaves past_due exactly one way: a delivered Paddle webhook.
  // Nothing replays them, so one dropped event used to pin an account to
  // "update your card" forever — for a subscription Paddle had already
  // cancelled, with the re-subscribe path suppressed the whole time.

  it('still reads past_due while the period end is recent', () => {
    expect(derive(null, [sub('past_due', 'sub_1', endingIn(-1))])).toBe('past_due')
  })

  it('still reads past_due right up to the edge of the window', () => {
    const justInside = endingIn(-(PAST_DUE_STALE_AFTER_DAYS - 1))
    expect(derive(null, [sub('past_due', 'sub_1', justInside)])).toBe('past_due')
  })

  it('reads inactive once the row is older than the window', () => {
    const longGone = endingIn(-(PAST_DUE_STALE_AFTER_DAYS + 1))
    expect(derive(null, [sub('past_due', 'sub_1', longGone)])).toBe('inactive')
  })

  it('keeps dunning when a fresh past_due sits beside a stale one', () => {
    const history = [
      sub('past_due', 'sub_old', endingIn(-(PAST_DUE_STALE_AFTER_DAYS + 60))),
      sub('past_due', 'sub_new', endingIn(-2)),
    ]
    expect(derive(null, history)).toBe('past_due')
  })

  it('cannot judge a null period end, so it stays dunning', () => {
    // Guessing "expired" on a missing date would suppress a real payment
    // problem to tidy up an edge case. Subscription rows always carry a period.
    expect(derive(null, [sub('past_due', 'sub_1', null)])).toBe('past_due')
  })
})

describe('deriveBillingState — nothing to fix', () => {
  it('reports inactive for a cancelled subscription', () => {
    expect(derive(null, [sub('canceled')])).toBe('inactive')
  })

  it('reports inactive for an expired pass', () => {
    // The row still says `active`; findActiveEntitlement returned null because
    // current_period_end is in the past. Status alone would get this wrong.
    expect(derive(null, [pass()])).toBe('inactive')
  })

  it('reports inactive after a refund or chargeback', () => {
    expect(derive(null, [pass('refunded')])).toBe('inactive')
    expect(derive(null, [sub('chargeback')])).toBe('inactive')
  })

  it('reports inactive for someone who never bought anything', () => {
    expect(derive(null, [])).toBe('inactive')
  })

  it('reports inactive for a paused subscription — there is no card to fix', () => {
    expect(derive(null, [sub('paused')])).toBe('inactive')
  })
})
