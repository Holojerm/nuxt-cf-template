// The event registry is what funnels join on, so every name that is actually
// captured has to be in it — including the client-side checkout names, which
// are strings in app/utils/checkout.ts rather than typed call sites.

import { describe, expect, it } from 'vitest'

import { CHECKOUT_ABANDONED, CHECKOUT_EVENT_NAMES } from '../app/utils/checkout'
import {
  ANALYTICS_EVENTS,
  EVENT_NAME_PATTERN,
  isAnalyticsEvent,
  paddleSubscriptionEvent,
} from '../shared/utils/analytics-events'

describe('analytics event registry', () => {
  it('names every event in the shape PostHog and fleet.json accept', () => {
    for (const name of Object.keys(ANALYTICS_EVENTS)) expect(name).toMatch(EVENT_NAME_PATTERN)
  })

  it('registers every checkout event the Paddle overlay can produce', () => {
    for (const name of [...Object.values(CHECKOUT_EVENT_NAMES), CHECKOUT_ABANDONED]) {
      expect(isAnalyticsEvent(name), name).toBe(true)
    }
  })

  it('does not treat Object.prototype keys as events', () => {
    expect(isAnalyticsEvent('toString')).toBe(false)
    expect(isAnalyticsEvent('constructor')).toBe(false)
  })

  it('keeps the names the webhook recorded before the registry existed', () => {
    // Previously `paddle_${eventType.replace('.', '_')}` — PostHog history is
    // keyed on these strings, so the mapping must reproduce them exactly.
    expect(paddleSubscriptionEvent('subscription.past_due')).toBe('paddle_subscription_past_due')
    expect(paddleSubscriptionEvent('subscription.canceled')).toBe('paddle_subscription_canceled')
    expect(paddleSubscriptionEvent('subscription.brand_new')).toBe('paddle_subscription_updated')
  })
})
