import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyOps,
  registerOpsSeverity,
  resetOpsSeverityForTest,
  SERVER_ERROR_CRITICAL_COUNT,
} from '../server/utils/ops-severity'

afterEach(() => resetOpsSeverityForTest())

describe('classifyOps', () => {
  it('treats a kind nobody registered as a warning, never as info', () => {
    expect(classifyOps('brand_new_failure', 1)).toEqual({ severity: 'warning' })
  })

  it('escalates server errors only in a burst', () => {
    expect(classifyOps('server_error', 1).severity).toBe('warning')
    const burst = classifyOps('server_error', SERVER_ERROR_CRITICAL_COUNT)
    expect(burst.severity).toBe('critical')
    expect(burst.action).toBeTruthy()
  })

  it('uses a registered tier, and lets a later registration re-tier a kind', () => {
    registerOpsSeverity({ export_noted: { severity: 'info' } })
    expect(classifyOps('export_noted', 1).severity).toBe('info')
    registerOpsSeverity({ export_noted: { severity: 'critical', action: 'x' } })
    expect(classifyOps('export_noted', 1)).toEqual({ severity: 'critical', action: 'x' })
  })

  it('lets an app override the core server_error rule', () => {
    registerOpsSeverity({ server_error: { severity: 'info' } })
    expect(classifyOps('server_error', SERVER_ERROR_CRITICAL_COUNT).severity).toBe('info')
  })
})
