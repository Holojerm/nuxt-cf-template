import { describe, expect, it } from 'vitest'

import {
  AUTH_ERROR_FALLBACK,
  AUTH_ERROR_MESSAGES,
  authErrorCode,
  authErrorMessage,
} from '../app/utils/auth-errors'

describe('authErrorMessage', () => {
  it('maps every known code to its sentence', () => {
    for (const [code, message] of Object.entries(AUTH_ERROR_MESSAGES)) {
      expect(authErrorMessage(code)).toBe(message)
    }
  })

  it('returns null when there is nothing to show', () => {
    for (const empty of [undefined, null, '', 0, {}, ['link_used']]) {
      expect(authErrorMessage(empty)).toBeNull()
    }
  })

  it('never echoes an unknown code back at the reader', () => {
    const hostile = '<script>alert(1)</script>'
    const message = authErrorMessage(hostile)
    expect(message).toBe(AUTH_ERROR_MESSAGES[AUTH_ERROR_FALLBACK])
    expect(message).not.toContain('script')
  })

  it('does not resolve inherited object keys', () => {
    expect(authErrorMessage('toString')).toBe(AUTH_ERROR_MESSAGES[AUTH_ERROR_FALLBACK])
    expect(authErrorMessage('__proto__')).toBe(AUTH_ERROR_MESSAGES[AUTH_ERROR_FALLBACK])
  })
})

describe('authErrorCode', () => {
  it('reads the doubly nested data.data.code of a thrown $fetch error', () => {
    expect(authErrorCode({ data: { data: { code: 'link_expired' } } })).toBe('link_expired')
  })

  it('falls back when the shape is missing or wrong', () => {
    for (const bad of [undefined, null, {}, { data: {} }, { data: { code: 'link_used' } }]) {
      expect(authErrorCode(bad)).toBe(AUTH_ERROR_FALLBACK)
    }
  })
})
