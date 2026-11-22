// The checkout funnel's names and the return-from-Stripe parser.
//
// Worth pinning: the event names must exist in the core analytics registry
// (funnels join on them), and the return state must accept only the two values
// Stripe's redirect carries, since anyone can type a query string.

import { describe, expect, it } from 'vitest'

import { isAnalyticsEvent } from '#shared/utils/analytics-events'
import {
  CHECKOUT_ABANDONED,
  CHECKOUT_COMPLETED,
  CHECKOUT_STARTED,
  CHECKOUT_UNAVAILABLE,
  checkoutReturnState,
} from '../app/utils/checkout'

describe('checkout event names', () => {
  it('are all registered in the core analytics registry, which funnels join on', () => {
    for (const name of [
      CHECKOUT_STARTED,
      CHECKOUT_UNAVAILABLE,
      CHECKOUT_COMPLETED,
      CHECKOUT_ABANDONED,
    ]) {
      expect(isAnalyticsEvent(name), name).toBe(true)
    }
  })
})

describe('checkoutReturnState', () => {
  it('reads the two values Stripe’s redirect carries', () => {
    expect(checkoutReturnState({ checkout: 'success' })).toBe('success')
    expect(checkoutReturnState({ checkout: 'canceled' })).toBe('canceled')
  })

  it('takes the first of a repeated parameter', () => {
    expect(checkoutReturnState({ checkout: ['success', 'canceled'] })).toBe('success')
  })

  it('ignores anything else', () => {
    expect(checkoutReturnState({})).toBeNull()
    expect(checkoutReturnState({ checkout: 'cancelled' })).toBeNull()
    expect(checkoutReturnState({ checkout: '' })).toBeNull()
    expect(checkoutReturnState({ checkout: 42 })).toBeNull()
  })
})
