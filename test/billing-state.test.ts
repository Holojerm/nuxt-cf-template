// The status matrix behind every dunning surface in the app.
//
// It is one small function, but it is the function that decides whether a
// customer is told "your payment failed, here's the fix" or "you don't have a
// plan, would you like to buy one" — so the whole table is enumerated rather
// than spot-checked. The `past_due` rows in particular have to keep agreeing
// with ACTIVE_STATUSES in server/utils/entitlements.ts, which excludes
// past_due: if that ever changes, these expectations are where it should hurt.

import { describe, expect, it } from 'vitest'
import { deriveBillingState } from '../server/utils/billing-state'
import type { BillingStateRow } from '../server/utils/billing-state'

const sub = (status: string, id = 'sub_1'): BillingStateRow => ({
  paddleSubscriptionId: id,
  status,
})
const pass = (status = 'active', id = 'txn_1'): BillingStateRow => ({
  paddleSubscriptionId: id,
  status,
})

describe('deriveBillingState — access granted', () => {
  it('reports active for a granting subscription', () => {
    expect(deriveBillingState(sub('active'), [sub('active')])).toBe('active')
  })

  it('reports trialing separately, because the copy differs', () => {
    expect(deriveBillingState(sub('trialing'), [sub('trialing')])).toBe('trialing')
  })

  it('reports active for an unexpired one-time pass', () => {
    // A pass has no lifecycle status of its own — findActiveEntitlement decided
    // it still grants by date, and that is all this function needs to know.
    expect(deriveBillingState(pass(), [pass()])).toBe('active')
  })
})

describe('deriveBillingState — dunning', () => {
  it('reports past_due when a subscription payment failed', () => {
    expect(deriveBillingState(null, [sub('past_due')])).toBe('past_due')
  })

  it('finds the past_due row behind older ended ones', () => {
    const history = [sub('past_due', 'sub_2'), sub('canceled', 'sub_1'), pass('active', 'txn_old')]
    expect(deriveBillingState(null, history)).toBe('past_due')
  })

  it('lets a live pass outrank a past_due subscription', () => {
    // Access is genuinely still granted, so "your access is paused" would be a
    // lie. The dunning state surfaces when the pass expires.
    const history = [pass(), sub('past_due')]
    expect(deriveBillingState(pass(), history)).toBe('active')
  })

  it('never reads past_due off a pass row', () => {
    // Paddle emits no subscription lifecycle for a `txn_`, so this shouldn't
    // exist — but a state machine that trusts its inputs is one bad webhook
    // away from telling someone to update a card they never saved.
    expect(deriveBillingState(null, [pass('past_due')])).toBe('inactive')
  })

  it('never reads past_due off a comped row', () => {
    // A `comp_` grant (server/utils/admin-grants.ts) has no card behind it at
    // all. Reading one as dunning would tell someone to fix a payment method
    // for access support handed them for free — an invented problem, and a
    // support conversation about a charge that never happened.
    const comp: BillingStateRow = { paddleSubscriptionId: 'comp_x', status: 'past_due' }
    expect(deriveBillingState(null, [comp])).toBe('inactive')
  })
})

describe('deriveBillingState — nothing to fix', () => {
  it('reports inactive for a cancelled subscription', () => {
    expect(deriveBillingState(null, [sub('canceled')])).toBe('inactive')
  })

  it('reports inactive for an expired pass', () => {
    // The row still says `active`; findActiveEntitlement returned null because
    // current_period_end is in the past. Status alone would get this wrong.
    expect(deriveBillingState(null, [pass()])).toBe('inactive')
  })

  it('reports inactive after a refund or chargeback', () => {
    expect(deriveBillingState(null, [pass('refunded')])).toBe('inactive')
    expect(deriveBillingState(null, [sub('chargeback')])).toBe('inactive')
  })

  it('reports inactive for someone who never bought anything', () => {
    expect(deriveBillingState(null, [])).toBe('inactive')
  })

  it('reports inactive for a paused subscription — there is no card to fix', () => {
    expect(deriveBillingState(null, [sub('paused')])).toBe('inactive')
  })
})
