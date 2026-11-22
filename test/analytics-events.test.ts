// The event registry is what funnels join on, so every name that is actually
// captured has to be in it. The client-side checkout names (strings in the
// billing layer's layers/billing/app/utils/checkout.ts) are checked against it in
// layers/billing/test/checkout.test.ts.

import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_EVENTS,
  EVENT_NAME_PATTERN,
  isAnalyticsEvent,
  billingSubscriptionEvent,
} from '../shared/utils/analytics-events'

describe('analytics event registry', () => {
  it('names every event in the shape PostHog and fleet.json accept', () => {
    for (const name of Object.keys(ANALYTICS_EVENTS)) expect(name).toMatch(EVENT_NAME_PATTERN)
  })

  it('does not treat Object.prototype keys as events', () => {
    expect(isAnalyticsEvent('toString')).toBe(false)
    expect(isAnalyticsEvent('constructor')).toBe(false)
  })

  it('maps a subscription event type to its registered name', () => {
    // Registered names only: an unknown suffix must not mint a new event name.
    expect(billingSubscriptionEvent('subscription.created')).toBe('billing_subscription_created')
    expect(billingSubscriptionEvent('subscription.canceled')).toBe('billing_subscription_canceled')
    expect(billingSubscriptionEvent('subscription.brand_new')).toBe('billing_subscription_updated')
  })
})
