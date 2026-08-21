// Comp access — the apology grant.
//
// The single most common thing a consumer support person needs to do: something
// broke, someone lost a week, give them time back. Without it the only tools
// are "refund the whole thing" (which ends the relationship) and "sorry"
// (which doesn't).
//
// Like entitlements.ts, the db comes in as the first argument so
// test/admin-grants.test.ts can drive real grants against a real D1.
//
// ── Why this is a thin wrapper and not its own write path ────────────────────
// It calls grantPass() — the exact function the Paddle webhook calls — rather
// than inserting an entitlement itself. Stacking, idempotency, and the
// truncate-to-whole-seconds rule are money logic that already exists, is
// already tested, and must not exist twice: a second copy diverges on the first
// change to the first copy, and the divergence shows up as a customer with the
// wrong expiry date and no way to tell which path wrote it.
//
// ── The ref, and why its prefix matters ──────────────────────────────────────
// `entitlements.paddle_subscription_id` holds a unique Paddle ref, and the
// prefix on that ref is load-bearing (see the header of entitlements.ts):
//
//   - `sub_…` rows follow Paddle's status lifecycle. findActiveEntitlement()
//     grants access to a `sub_` row on status ALONE, ignoring the date, because
//     Paddle is expected to flip the status when it ends. A comp pass using
//     that prefix would be permanent access that no webhook ever revokes and
//     no expiry ever catches. Never mint one.
//   - Anything else grants access only while current_period_end is in the
//     future — which is exactly the semantics comp access wants.
//
// So the prefix here is `comp_`, not `txn_`: both expire by date, but `txn_`
// claims a Paddle transaction exists behind it. Reconciling revenue against a
// transaction id that Paddle has never heard of is a bad afternoon. `comp_`
// says what it is, reads as a comp in the billing history on /account, and is
// greppable in a way "the rows with no matching Paddle transaction" is not.

// Imported explicitly rather than leaning on the Nitro auto-import: this file
// is loaded directly by the workerd vitest suite, where nothing is injected.
import { PASS_DAYS, findActiveEntitlement, grantPass } from './entitlements'
import type { EntitlementDb } from './entitlements'

/** Prefix on every comped entitlement ref. Never `sub_` — see above. */
export const COMP_REF_PREFIX = 'comp_'

/**
 * Ceiling on one grant. A year of free access in a single click is not a
 * support action, it's an accident — and the bound is what makes the audit row
 * "2 passes" instead of "how did this person get 400 days".
 */
export const MAX_COMP_PASSES = 12

/** A fresh, unique comp ref. UUID because the unique index is the only guard. */
export function compRef(): string {
  return `${COMP_REF_PREFIX}${crypto.randomUUID()}`
}

/** Is this entitlement comped rather than paid? Used to label billing history. */
export function isCompRef(ref: string): boolean {
  return ref.startsWith(COMP_REF_PREFIX)
}

export interface GrantCompPassesParams {
  userId: string
  /** How many whole passes to grant, 1…MAX_COMP_PASSES. */
  passes?: number
  productKey?: string
  /**
   * Refs minted by the caller. The admin endpoint mints them *before* writing
   * its audit row so the row names the exact entitlements it is about to
   * create — audit-before-act means the outcome isn't available yet, but the
   * identifiers are (see server/utils/audit.ts).
   */
  refs?: string[]
  /** Defaults to now; injectable so tests can grant at a fixed instant. */
  now?: Date
}

export interface GrantCompPassesResult {
  /** One ref per pass granted, in the order they were applied. */
  refs: string[]
  passes: number
  /** Whole days of access added — passes × PASS_DAYS. */
  days: number
  /** When the user's access now ends. */
  endsAt: Date
  /**
   * The expiry the grant stacked on top of, or null if access started today.
   * Worth returning rather than recomputing: it is the difference between
   * "extended to March 4" and "granted until March 4" in the confirmation, and
   * telling a customer the wrong one costs a second support round trip.
   */
  stackedOn: Date | null
}

/**
 * Grant comp access as whole passes.
 *
 * ── Why passes and not an arbitrary day count ────────────────────────────────
 * grantPass() grants PASS_DAYS and stacks from the running expiry, and that
 * rule is stated on /pricing. Granting "17 days" would need a second duration
 * rule living next to the first one, and the two would disagree the first time
 * PASS_DAYS moved. A comp is the same thing the customer would have bought,
 * given rather than sold — so it is denominated in the same unit, refunds the
 * same way, and appears in billing history in the same shape.
 *
 * Each pass is its own row, exactly as a purchased one is: refunding or
 * reversing one leaves the others alone.
 */
export async function grantCompPasses(
  db: EntitlementDb,
  params: GrantCompPassesParams,
): Promise<GrantCompPassesResult> {
  const passes = params.passes ?? 1
  if (!Number.isInteger(passes) || passes < 1 || passes > MAX_COMP_PASSES) {
    throw new Error(`passes must be an integer between 1 and ${MAX_COMP_PASSES}`)
  }

  const productKey = params.productKey ?? 'default'
  const now = params.now ?? new Date()
  const refs = params.refs ?? Array.from({ length: passes }, () => compRef())
  if (refs.length !== passes) {
    throw new Error(`expected ${passes} refs, got ${refs.length}`)
  }
  // A `sub_` ref here would mint access that never expires. Cheap assertion,
  // catastrophic omission — and the caller supplies these, so "we always mint
  // them correctly" is not something this function gets to assume.
  const bad = refs.find((ref) => !isCompRef(ref))
  if (bad) throw new Error(`comp refs must start with ${COMP_REF_PREFIX}: ${bad}`)

  // What they had before the first pass landed. Read up front because every
  // grant after the first stacks on the one before it, and by the end the
  // original expiry is no longer recoverable from the table.
  const before = await findActiveEntitlement(db, params.userId, productKey)
  const stackedOn =
    before?.currentPeriodEnd && before.currentPeriodEnd > now ? before.currentPeriodEnd : null

  // Sequential, not batched: each grantPass() has to see the row the previous
  // one wrote, or they all stack on the same base and N passes buy 30 days.
  let endsAt = stackedOn ?? now
  for (const ref of refs) {
    const result = await grantPass(db, {
      userId: params.userId,
      transactionId: ref,
      productKey,
      billedAt: now,
    })
    endsAt = result.endsAt
  }

  return { refs, passes, days: passes * PASS_DAYS, endsAt, stackedOn }
}
