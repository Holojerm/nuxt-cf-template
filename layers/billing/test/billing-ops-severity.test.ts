import { afterEach, describe, expect, it } from 'vitest'

import { classifyOps, resetOpsSeverityForTest } from '../../../server/utils/ops-severity'
import { registerBillingExtensions } from '../server/utils/billing-extensions'

afterEach(() => resetOpsSeverityForTest())

describe('billing ops severity', () => {
  it('registers a missing webhook secret as critical, and leaves the rest at warning', () => {
    registerBillingExtensions()
    const unconfigured = classifyOps('paddle_webhook_unconfigured', 1)
    expect(unconfigured.severity).toBe('critical')
    expect(unconfigured.action).toContain('NUXT_PADDLE_WEBHOOK_SECRET')
    expect(classifyOps('paddle_webhook_rejected', 1).severity).toBe('warning')
  })
})
