// Bearer check for /api/fleet.
//
// The fleet dashboard is a separate Worker with no session here, so it
// presents a shared secret instead. Two tokens are accepted — current and
// previous — so rotation is a three-step that never has a moment where the
// dashboard is locked out: set the fork's PREVIOUS to the old value and its
// current to the new one, switch the dashboard to the new one, then clear
// PREVIOUS. At no point does either side hold a token the other rejects.
//
// Pure and side-effect free, so test/fleet-auth.test.ts can enumerate the
// verdicts without a request.

import { sha256Hex, timingSafeEqual } from './hash'

export type FleetTokenVerdict = 'ok' | 'unauthorized' | 'unconfigured'

/**
 * Shorter than this and the token is not a secret, it is a guess waiting to
 * happen. `openssl rand -base64 32` gives 44 characters.
 */
export const FLEET_TOKEN_MIN_LENGTH = 32

export interface FleetTokens {
  current: string | undefined
  previous?: string | undefined
}

/**
 * `unconfigured` when no usable token is set — the route should 404, so an
 * app that has not opted into the dashboard does not advertise an endpoint
 * that only ever says no. `unauthorized` for a missing, malformed, or wrong
 * bearer. `ok` otherwise.
 *
 * Compared as SHA-256 digests so the constant-time comparison always sees
 * equal-length inputs; a bare timingSafeEqual on the raw strings would leak
 * the token's length through its early length check.
 */
export async function verifyFleetToken(
  authorization: string | null | undefined,
  tokens: FleetTokens,
): Promise<FleetTokenVerdict> {
  const current = tokens.current?.trim() ?? ''
  if (!current) return 'unconfigured'
  if (current.length < FLEET_TOKEN_MIN_LENGTH) {
    // Refusing is the safe direction: a weak token that works is indistinguishable
    // from a strong one until the day it isn't.
    console.warn(JSON.stringify({ kind: 'fleet_token_too_short', length: current.length }))
    return 'unconfigured'
  }

  const presented = bearerToken(authorization)
  if (!presented) return 'unauthorized'

  const candidates = [current, tokens.previous?.trim()].filter(
    (token): token is string => !!token && token.length >= FLEET_TOKEN_MIN_LENGTH,
  )
  const presentedHash = await sha256Hex(presented)
  for (const candidate of candidates) {
    if (timingSafeEqual(presentedHash, await sha256Hex(candidate))) return 'ok'
  }
  return 'unauthorized'
}

/** The token out of `Authorization: Bearer <token>`, or null. Scheme is case-insensitive per RFC 9110. */
export function bearerToken(authorization: string | null | undefined): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')
  return match?.[1] ?? null
}
