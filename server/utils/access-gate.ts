// The paywall seam: "may this signed-in person use the paid thing?"
//
// Routes that sit behind a paywall call `requireAccess(event)`. The billing
// layer registers the real check (an entitlement for the product); without it
// the stand-in below applies, which is the "free, but sign-in required" option
// in TEARDOWN.md. A layer that gates routes (files) therefore never imports
// billing, and a fork without billing needs no stub file to compile.
//
// A plain module registry like server/utils/extensions.ts, for the same reason:
// the consumers must work where Nitro hooks do not exist (the workerd tests).

import type { H3Event } from 'h3'

/** What a passing gate returns. Billing's check adds the entitlement it found. */
export interface AccessGrant {
  user: Awaited<ReturnType<typeof requireUserSession>>['user']
}

export type AccessGate = (event: H3Event, productKey: string) => Promise<AccessGrant>

let accessGate: AccessGate | null = null

/** Replace the gate. One gate per app: the last registration wins. */
export function registerAccessGate(gate: AccessGate): void {
  accessGate = gate
}

/**
 * Require a signed-in user who may use `productKey`.
 *
 *   const { user } = await requireAccess(event)
 *
 * Registered gate: whatever it throws (billing: 401 signed out, 402 without an
 * entitlement). No gate: 401 when signed out, otherwise allowed.
 */
export async function requireAccess(event: H3Event, productKey = 'default'): Promise<AccessGrant> {
  if (accessGate) return accessGate(event, productKey)
  const { user } = await requireUserSession(event)
  return { user }
}

/** Test-only: back to the stand-in. */
export function clearAccessGateForTest(): void {
  accessGate = null
}
