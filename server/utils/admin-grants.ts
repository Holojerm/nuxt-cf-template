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
import { and, eq, inArray } from 'drizzle-orm'
import * as tables from '../db/schema'
import { ACTIVE_STATUSES, PASS_DAYS, findActiveEntitlement, grantPass } from './entitlements'
import type { EntitlementDb } from './entitlements'
import type { Entitlement } from '../db/schema'

/** Prefix on every comped entitlement ref. Never `sub_` — see above. */
export const COMP_REF_PREFIX = 'comp_'

/**
 * Ceiling on ONE grant — nothing more.
 *
 * Worth being precise, because the obvious reading is wrong: this does not
 * bound how much comp access an account can accumulate. Grants stack, so twice
 * this is two clicks away and there is no cumulative limit anywhere. What the
 * bound actually buys is that a slip of the finger cannot hand out a year, and
 * that anything larger has to be a deliberate, repeated, individually-audited
 * act rather than one absent-minded selection.
 *
 * The cumulative case is handled by the other two halves of this file's
 * contract, not by a number: every grant is on the audit trail with a stated
 * reason, and revokeCompPass() below can take any of them back.
 */
export const MAX_COMP_PASSES = 12

/**
 * Status written when an admin takes a comp back.
 *
 * Distinct from REVOKED_STATUS in entitlements.ts (`refunded` / `chargeback`)
 * because those describe money moving in the other direction, and a comp never
 * involved any. Reading "refunded" against a grant nobody paid for would send
 * whoever is reconciling revenue looking for a transaction that never existed.
 *
 * Nothing needs to learn about this string to respect it: access is decided by
 * an ALLOWLIST (ACTIVE_STATUSES = active | trialing), so any status outside it
 * stops granting by construction — findActiveEntitlement, deriveBillingState,
 * requireSubscription, and the MCP worker's raw SQL all fall in line for free.
 * That is why this change is small, and it is a property to preserve: never
 * turn that allowlist into a denylist of "ended" statuses.
 */
export const COMP_REVOKED_STATUS = 'revoked'

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

// ─── Taking it back ─────────────────────────────────────────────────────────

export type RevokeCompOutcome =
  /** The row was granting access and no longer is. */
  | 'revoked'
  /** No entitlement with that ref belongs to this user. */
  | 'not_found'
  /** The ref is real but not a comp — refuse. See the note on the function. */
  | 'not_comp'
  /** Already ended (revoked earlier, refunded, charged back). A no-op. */
  | 'already_revoked'

export interface RevokeCompParams {
  /** The owner. Part of the WHERE, so a ref alone cannot reach another account. */
  userId: string
  /** The `comp_…` ref to take back. */
  ref: string
  now?: Date
}

export interface RevokeCompResult {
  outcome: RevokeCompOutcome
  ref: string
  /** The expiry that was taken away — only set when something was revoked. */
  revokedEndsAt?: Date | null
  /**
   * What still grants access afterwards, or null if nothing does. Read after
   * the write so support can say "they still have until the 14th" rather than
   * guessing, which is the difference between one call and two.
   */
  remainingEndsAt?: Date | null
}

/**
 * Take back a comp grant — the inverse of grantCompPasses().
 *
 * ── Why this had to exist ────────────────────────────────────────────────────
 * Every other way an entitlement ends is driven by Paddle: revokeForAdjustment()
 * handles refunds and chargebacks, and it matches on refs Paddle sends. A
 * `comp_` row has no Paddle side, so nothing could ever end one early. An admin
 * who granted twelve passes by mistake had no remedy inside the product — the
 * fix was hand-written SQL against production, which is both the least
 * auditable thing available and the exact operation this console exists to
 * replace.
 *
 * ── Comps only, and that is a hard rule ─────────────────────────────────────
 * A `sub_` or `txn_` row is refused (`not_comp`). Paddle is the source of truth
 * for anything money touched: setting a local status on a subscription Paddle
 * still considers live gets silently overwritten by the next `subscription.*`
 * event, so it would look like it worked and quietly stop working. Worse, on a
 * paid pass it would take away access the customer *bought* with no refund
 * attached — support reaching past the billing system to un-sell something.
 * Refunds go through Paddle, and the webhook brings the result back.
 *
 * ── What "revoked" does to the row ──────────────────────────────────────────
 * The same two things revokeForAdjustment() does, for the same reason: a
 * non-granting status AND an expired `current_period_end`. Either alone would
 * do, which is precisely why both are set — the status is what the app's
 * allowlist reads, the date is what anything checking only the window reads
 * (the MCP worker's raw SQL, a future report), and the two must never disagree
 * about whether someone has access.
 *
 * The row is never deleted. It stays in billing history as a comp that was
 * granted and withdrawn, because that is what happened.
 */
export async function revokeCompPass(
  db: EntitlementDb,
  params: RevokeCompParams,
): Promise<RevokeCompResult> {
  const { userId, ref } = params
  const now = params.now ?? new Date()

  // Checked before touching the table: refusing by shape means a paid ref can
  // never reach the UPDATE below, even if the row lookup were wrong.
  if (!isCompRef(ref)) return { outcome: 'not_comp', ref }

  const row: Entitlement | undefined = await db.query.entitlements.findFirst({
    where: and(
      eq(tables.entitlements.paddleSubscriptionId, ref),
      // Scoped to the owner, so a ref from one account cannot revoke on another.
      eq(tables.entitlements.userId, userId),
    ),
  })
  if (!row) return { outcome: 'not_found', ref }

  const revoked = await db
    .update(tables.entitlements)
    .set({
      status: COMP_REVOKED_STATUS,
      currentPeriodEnd: now,
      updatedAt: new Date(),
    })
    // The guards are repeated in the WHERE rather than trusted from the read
    // above. Two admins clicking revoke at once both pass the read; only one
    // matches here, and the loser gets `already_revoked` instead of writing a
    // second, later `current_period_end` over the first.
    .where(
      and(
        eq(tables.entitlements.paddleSubscriptionId, ref),
        eq(tables.entitlements.userId, userId),
        inArray(tables.entitlements.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ id: tables.entitlements.id })

  if (!revoked.length) return { outcome: 'already_revoked', ref }

  const remaining = await findActiveEntitlement(db, userId, row.productKey)
  return {
    outcome: 'revoked',
    ref,
    revokedEndsAt: row.currentPeriodEnd,
    remainingEndsAt: remaining?.currentPeriodEnd ?? null,
  }
}
