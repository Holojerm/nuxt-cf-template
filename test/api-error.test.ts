import { describe, expect, it } from 'vitest'

import { apiErrorMessage } from '../app/utils/api-error'

const FALLBACK = 'Something went wrong.'

describe('apiErrorMessage', () => {
  it('returns the server message from a FetchError body', () => {
    expect(apiErrorMessage({ status: 400, data: { message: 'Email is taken' } }, FALLBACK)).toBe(
      'Email is taken',
    )
  })

  it('falls back to statusMessage when there is no message', () => {
    expect(apiErrorMessage({ data: { statusMessage: 'Not found' } }, FALLBACK)).toBe('Not found')
  })

  it('never surfaces a 5xx message', () => {
    expect(apiErrorMessage({ status: 500, data: { message: 'db exploded' } }, FALLBACK)).toBe(
      FALLBACK,
    )
    expect(apiErrorMessage({ statusCode: 503, data: { message: 'busy' } }, FALLBACK)).toBe(FALLBACK)
    expect(apiErrorMessage({ data: { statusCode: 502, message: 'bad gateway' } }, FALLBACK)).toBe(
      FALLBACK,
    )
  })

  it('returns the fallback for raw errors and non-objects', () => {
    expect(apiErrorMessage(new TypeError('Failed to fetch'), FALLBACK)).toBe(FALLBACK)
    expect(apiErrorMessage(null, FALLBACK)).toBe(FALLBACK)
    expect(apiErrorMessage('boom', FALLBACK)).toBe(FALLBACK)
    expect(apiErrorMessage({ data: { message: '' } }, FALLBACK)).toBe(FALLBACK)
    expect(apiErrorMessage({ data: { message: 42 } }, FALLBACK)).toBe(FALLBACK)
  })
})
