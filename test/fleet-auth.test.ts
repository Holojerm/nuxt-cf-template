// The bearer check on /api/fleet, enumerated.
//
// Three verdicts, and the one that matters most is the boring one: an app
// with no token configured must read as `unconfigured` (the route 404s), not
// `unauthorized` (the route would advertise itself to anyone who probes it).

import { describe, expect, it } from 'vitest'

import { bearerToken, FLEET_TOKEN_MIN_LENGTH, verifyFleetToken } from '../server/utils/fleet-auth'

const CURRENT = 'current-token-0123456789abcdef0123456789abcdef'
const PREVIOUS = 'previous-token-0123456789abcdef0123456789abcde'

describe('bearerToken', () => {
  it('reads the token out of a Bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
  })

  it('is case-insensitive on the scheme, as RFC 9110 says', () => {
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('BEARER abc')).toBe('abc')
  })

  it('rejects other schemes, empty values, and absent headers', () => {
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

describe('verifyFleetToken', () => {
  it('is unconfigured with no current token, whatever the request says', async () => {
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, { current: '' })).toBe('unconfigured')
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, { current: undefined })).toBe('unconfigured')
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, { current: '   ' })).toBe('unconfigured')
  })

  it('treats a token shorter than the floor as unconfigured — a weak secret is no secret', async () => {
    const short = 'x'.repeat(FLEET_TOKEN_MIN_LENGTH - 1)
    expect(await verifyFleetToken(`Bearer ${short}`, { current: short })).toBe('unconfigured')
  })

  it('a previous token alone does not configure the route', async () => {
    expect(await verifyFleetToken(`Bearer ${PREVIOUS}`, { current: '', previous: PREVIOUS })).toBe(
      'unconfigured',
    )
  })

  it('is unauthorized for a missing, malformed, or wrong bearer', async () => {
    const tokens = { current: CURRENT }
    expect(await verifyFleetToken(undefined, tokens)).toBe('unauthorized')
    expect(await verifyFleetToken('', tokens)).toBe('unauthorized')
    expect(await verifyFleetToken(`Basic ${CURRENT}`, tokens)).toBe('unauthorized')
    expect(await verifyFleetToken(`Bearer ${CURRENT}x`, tokens)).toBe('unauthorized')
    expect(await verifyFleetToken(`Bearer ${CURRENT.slice(1)}`, tokens)).toBe('unauthorized')
  })

  it('accepts the current token', async () => {
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, { current: CURRENT })).toBe('ok')
    expect(await verifyFleetToken(`bearer ${CURRENT}`, { current: CURRENT })).toBe('ok')
  })

  it('accepts the previous token during a rotation, and nothing else', async () => {
    const tokens = { current: CURRENT, previous: PREVIOUS }
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, tokens)).toBe('ok')
    expect(await verifyFleetToken(`Bearer ${PREVIOUS}`, tokens)).toBe('ok')
    expect(await verifyFleetToken(`Bearer ${PREVIOUS}x`, tokens)).toBe('unauthorized')
  })

  it('ignores a previous token that is too short to count', async () => {
    const weak = 'short-previous'
    expect(await verifyFleetToken(`Bearer ${weak}`, { current: CURRENT, previous: weak })).toBe(
      'unauthorized',
    )
  })

  it('tolerates whitespace around configured values — copy-paste from a secret store', async () => {
    expect(await verifyFleetToken(`Bearer ${CURRENT}`, { current: ` ${CURRENT}\n` })).toBe('ok')
  })
})
