// Access that was earned rather than bought, as a seam: the referral loop
// decides WHO gets days and WHY; whichever feature owns entitlements decides
// how days are stacked, stored and counted. Billing registers the provider
// (layers/billing/server/utils/billing-earned-access.ts); the referral loop asks
// for it and never imports billing.
//
// With no provider registered there is nothing to write days into, and callers
// must treat that as "grants nothing", not as an error: `getEarnedAccess()`
// returns null and the referral loop answers `unavailable` (it still captures
// codes and resolves who invited whom).
//
// ── What the provider guarantees ─────────────────────────────────────────────
// - `plan` stacks on the longest-running grant, so nobody loses days they hold.
// - `write` is idempotent on `ref` by the unique index and reports what the
//   database did (DO NOTHING … RETURNING), not what the caller expected.
// - `exists` is a point lookup on the unique ref.
// - `countByPrefix` counts a user's rows whose ref starts with a prefix;
//   `standingOnly` leaves out rows that were granted and later clawed back.

import type { ExtensionDb } from './extensions'

export interface EarnedGrantParams {
  userId: string
  ref: string
  days: number
  /** The purchase this exists because of, or null for a grant nobody paid for. */
  earnedFromRef?: string | null
  productKey?: string
  now?: Date
}

/** What a grant would do, worked out before anything is written. */
export interface EarnedGrantPlan {
  ref: string
  days: number
  /** When the window opens: the stacking base, stored so a clawback can measure it. */
  startsAt: Date
  /** Truncated to whole seconds, because that is D1's resolution for a timestamp. */
  endsAt: Date
  /** The expiry these days were laid on top of, or null if access starts today. */
  stackedOn: Date | null
  productKey: string
  userId: string
  earnedFromRef: string | null
}

export interface EarnedAccessProvider {
  plan: (db: ExtensionDb, params: EarnedGrantParams) => Promise<EarnedGrantPlan>
  write: (db: ExtensionDb, plan: EarnedGrantPlan) => Promise<{ granted: boolean; endsAt: Date }>
  exists: (db: ExtensionDb, ref: string) => Promise<boolean>
  countByPrefix: (
    db: ExtensionDb,
    userId: string,
    prefix: string,
    options?: { standingOnly?: boolean },
  ) => Promise<number>
}

let provider: EarnedAccessProvider | null = null

export function registerEarnedAccess(next: EarnedAccessProvider): void {
  provider = next
}

/** The registered provider, or null when nothing can hold earned access. */
export function getEarnedAccess(): EarnedAccessProvider | null {
  return provider
}

/** Test-only: forget the provider. */
export function clearEarnedAccessForTest(): void {
  provider = null
}
