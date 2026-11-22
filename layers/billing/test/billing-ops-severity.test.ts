import { afterEach, describe, expect, it } from 'vitest'

import { classifyOps, resetOpsSeverityForTest } from '../../../server/utils/ops-severity'
import { registerBillingExtensions } from '../server/utils/billing-extensions'

afterEach(() => resetOpsSeverityForTest())

describe('billing ops severity', () => {
  it('registers a missing webhook secret as critical, and leaves the rest at warning', () => {
    registerBillingExtensions()
    const unconfigured = classifyOps('stripe_webhook_unconfigured', 1)
    expect(unconfigured.severity).toBe('critical')
    expect(unconfigured.action).toContain('NUXT_STRIPE_WEBHOOK_SECRET')
    expect(classifyOps('stripe_webhook_rejected', 1).severity).toBe('warning')
  })
})
