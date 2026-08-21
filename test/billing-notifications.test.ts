// Which webhook events produce an email, and which stay quiet.
//
// This is the table that keeps the payment-failed email out of the spam folder:
// if every subscription.updated triggered a message, people would filter the
// sender, and the one email that actually needs reading would go with it.

import { describe, expect, it } from 'vitest'
import { decideNotification } from '../server/utils/billing-notifications'
import type { PaddleEventOutcome } from '../server/utils/entitlements'

function subscription(status: string, previousStatus: string | null): PaddleEventOutcome {
  return { kind: 'subscription', userId: 'user-1', status, previousStatus }
}

describe('decideNotification — subscriptions', () => {
  it('emails on the first activation', () => {
    expect(decideNotification(subscription('active', null))).toMatchObject({
      email: 'purchase',
      kind: 'subscription',
    })
  })

  it('emails when a trial starts', () => {
    expect(decideNotification(subscription('trialing', null))).toMatchObject({ email: 'purchase' })
  })

  it('stays quiet when a trial converts to active', () => {
    // Both statuses already grant access — the customer noticed nothing.
    expect(decideNotification(subscription('active', 'trialing'))).toMatchObject({ email: 'none' })
  })

  it('stays quiet when nothing changed', () => {
    // Paddle sends subscription.updated for a card edit or a metadata tweak.
    expect(decideNotification(subscription('active', 'active'))).toMatchObject({
      email: 'none',
      reason: 'no_status_change',
    })
  })

  it('emails when a payment fails', () => {
    expect(decideNotification(subscription('past_due', 'active'))).toMatchObject({
      email: 'payment_failed',
    })
  })

  it('emails the recovery, once, when a past_due subscription pays', () => {
    expect(decideNotification(subscription('active', 'past_due'))).toMatchObject({
      email: 'purchase',
    })
  })

  it('emails on cancellation', () => {
    expect(decideNotification(subscription('canceled', 'active'))).toMatchObject({
      email: 'access_ended',
      reason: 'canceled',
    })
  })

  it('stays quiet on a pause', () => {
    expect(decideNotification(subscription('paused', 'active'))).toMatchObject({ email: 'none' })
  })

  it('passes the period end through to the purchase email', () => {
    const endsAt = new Date('2026-09-01T00:00:00Z')
    expect(decideNotification(subscription('active', null), endsAt)).toMatchObject({
      email: 'purchase',
      endsAt,
    })
  })
})

describe('decideNotification — one-time passes', () => {
  const endsAt = new Date('2026-09-20T00:00:00Z')

  it('emails a granted pass', () => {
    const outcome: PaddleEventOutcome = {
      kind: 'pass',
      userId: 'user-1',
      granted: true,
      endsAt,
      stackedOn: null,
    }
    expect(decideNotification(outcome)).toMatchObject({ email: 'purchase', kind: 'pass', endsAt })
  })

  it('stays quiet on a webhook redelivery', () => {
    // granted: false means we already recorded this transaction. Paddle
    // redelivers freely; a second "thanks for your purchase" is alarming.
    const outcome: PaddleEventOutcome = {
      kind: 'pass',
      userId: 'user-1',
      granted: false,
      endsAt,
      stackedOn: null,
    }
    expect(decideNotification(outcome)).toMatchObject({ email: 'none', reason: 'redelivery' })
  })
})

describe('decideNotification — refunds and chargebacks', () => {
  it('emails when a refund actually revoked access', () => {
    const outcome: PaddleEventOutcome = {
      kind: 'adjustment',
      action: 'refund',
      result: { outcome: 'revoked', userId: 'user-1', paddleRef: 'txn_1' },
    }
    expect(decideNotification(outcome)).toMatchObject({
      email: 'access_ended',
      reason: 'refunded',
    })
  })

  it('uses the chargeback wording for chargebacks', () => {
    const outcome: PaddleEventOutcome = {
      kind: 'adjustment',
      action: 'chargeback',
      result: { outcome: 'revoked', userId: 'user-1', paddleRef: 'txn_1' },
    }
    expect(decideNotification(outcome)).toMatchObject({ reason: 'chargeback' })
  })

  it('stays quiet when the adjustment matched nothing', () => {
    const outcome: PaddleEventOutcome = {
      kind: 'adjustment',
      action: 'refund',
      result: { outcome: 'no_matching_entitlement' },
    }
    expect(decideNotification(outcome)).toMatchObject({ email: 'none' })
  })

  it('stays quiet on a refund still awaiting approval', () => {
    const outcome: PaddleEventOutcome = {
      kind: 'adjustment',
      action: 'refund',
      result: { outcome: 'status_not_final' },
    }
    expect(decideNotification(outcome)).toMatchObject({ email: 'none' })
  })
})

describe('decideNotification — ignored events', () => {
  it('sends nothing for an event we deliberately skipped', () => {
    const outcome: PaddleEventOutcome = { kind: 'ignored', reason: 'unhandled_event' }
    expect(decideNotification(outcome)).toMatchObject({ email: 'none' })
  })
})
