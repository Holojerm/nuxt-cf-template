// Checkout funnel event mapping.
//
// Two things are worth pinning down. First, that a close following a completed
// payment is NOT counted as an abandonment — get that wrong and the
// abandonment rate is inflated by exactly the number of successful purchases,
// which is the one number this whole mechanism exists to measure. Second, that
// Paddle's event payload is allowlisted rather than spread, because it carries
// the customer's email and billing address.

import { describe, expect, it } from 'vitest'

import {
  CHECKOUT_ABANDONED,
  checkoutEventProperties,
  resolveCheckoutEvent,
} from '../app/utils/checkout'

describe('resolveCheckoutEvent', () => {
  it('maps the funnel events we care about', () => {
    expect(resolveCheckoutEvent('checkout.loaded', false)).toBe('checkout_loaded')
    expect(resolveCheckoutEvent('checkout.payment.failed', false)).toBe('checkout_payment_failed')
    expect(resolveCheckoutEvent('checkout.completed', true)).toBe('checkout_completed')
  })

  it('counts a close without a completion as an abandonment', () => {
    expect(resolveCheckoutEvent('checkout.closed', false)).toBe(CHECKOUT_ABANDONED)
  })

  it('drops the close that follows a successful payment', () => {
    // Paddle fires checkout.closed after checkout.completed. Reporting both
    // would make every purchase also look like an abandonment.
    expect(resolveCheckoutEvent('checkout.closed', true)).toBeNull()
  })

  it('ignores events with no funnel meaning', () => {
    expect(resolveCheckoutEvent('checkout.items.updated', false)).toBeNull()
    expect(resolveCheckoutEvent('something.invented', false)).toBeNull()
  })
})

describe('checkoutEventProperties', () => {
  it('extracts the commercially useful fields', () => {
    const props = checkoutEventProperties({
      items: [{ price_id: 'pri_123', quantity: 1 }],
      currency_code: 'USD',
      totals: { total: '12.00' },
    })
    expect(props).toMatchObject({
      price_ids: ['pri_123'],
      item_count: 1,
      currency: 'USD',
      total: '12.00',
    })
  })

  it('never forwards personal data from the payload', () => {
    const props = checkoutEventProperties({
      items: [{ price_id: 'pri_123' }],
      customer: { email: 'ada@example.com', address: { postal_code: 'SW1A 1AA' } },
      storage: { billing_details: 'sensitive' },
    })
    const serialized = JSON.stringify(props)
    expect(serialized).not.toContain('ada@example.com')
    expect(serialized).not.toContain('SW1A 1AA')
    expect(Object.keys(props).sort()).toEqual(['currency', 'item_count', 'price_ids', 'total'])
  })

  it('returns an empty object for a missing or non-object payload', () => {
    expect(checkoutEventProperties(undefined)).toEqual({})
    expect(checkoutEventProperties('nope')).toEqual({})
  })
})
