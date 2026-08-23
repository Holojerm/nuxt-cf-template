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
import { MAX_COMP_PASSES } from '#shared/utils/comps'
import * as tables from '../db/schema'
import {
  ACTIVE_STATUSES,
  PASS_DAYS,
  findActiveEntitlement,
  getBillingOverview,
  passEndDates,
  stackingBase,
  toSeconds,
} from './entitlements'
import type { EntitlementDb } from './entitlements'
import { COMP_REF_PREFIX, compRef, isCompRef } from './paddle-refs'
import type { Entitlement } from '../db/schema'

// COMP_REF_PREFIX / compRef / isCompRef moved to ./paddle-refs — every rule
// about what a ref prefix means now lives in one leaf. MAX_COMP_PASSES moved to
// #shared/utils/comps, because the admin page builds its selector from the same
// ceiling this file validates against and the two had already been typed twice.

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

export type GrantCompOutcome =
  /** Passes written. */
  | 'granted'
  /** Refused: the customer has a live subscription. See the note below. */
  | 'active_subscription'

export interface GrantCompPassesResult {
  outcome: GrantCompOutcome
  /** One ref per pass granted, in the order applied. Empty when refused. */
  refs: string[]
  passes: number
  /** Whole days of access added — passes × PASS_DAYS. Zero when refused. */
  days: number
  /** When the user's access now ends. Null when refused. */
  endsAt: Date | null
  /**
   * The expiry the grant stacked on top of, or null if access started today.
   * Worth returning rather than recomputing: it is the difference between
   * "extended to March 4" and "granted until March 4" in the confirmation, and
   * telling a customer the wrong one costs a second support round trip.
   */
  stackedOn: Date | null
  /** The subscription ref that caused a refusal, for the operator's message. */
  blockedBy?: string
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
 *
 * ── Why a live subscriber is REFUSED, not served ─────────────────────────────
 * Comping an active monthly subscriber delivers nothing and says three false
 * things while doing it.
 *
 * Nothing, because the days stack from the subscription's renewal date — and
 * that window is exactly what the customer's next payment buys. They gain zero
 * days unless the subscription ends first, which is not what "here's a free
 * month for the outage" means to anybody.
 *
 * False, because the comp row then outranks the subscription in
 * findActiveEntitlement's `ORDER BY current_period_end DESC`, and /account told
 * a paying customer "You have a one-time pass. It will not renew." beside a
 * working "Manage or cancel" button for the subscription it had just denied
 * existed. (entitlement-view.ts now pins the description to the live
 * subscription, so that half is fixed independently — this refusal is about the
 * days, not the label.)
 *
 * The alternative was to allow it with accurate copy — "these days apply only
 * after the subscription ends". Rejected: it is a control whose honest
 * description is a reason not to use it, offered to someone under time pressure
 * who will read "grant" and tell the customer they've been given a free month.
 * A refusal that names the right instrument is better support than a grant that
 * quietly does nothing. The right instrument is a Paddle credit or discount
 * against the next invoice, which is money back rather than time forward.
 *
 * `past_due` subscriptions are deliberately NOT blocked: access is already
 * paused there, so comp days are real days, and "here's a week while you sort
 * the card out" is a legitimate thing to do.
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

  // One read for both questions: is there a subscription already GRANTING
  // access (refuse), and what is currently granting access (the stacking base).
  //
  // `accessSubscriptionIds`, not `cancellableSubscriptionIds`: the question a
  // comp asks is "would these days be redundant", which is about access, not
  // about whether Paddle can still bill. During dunning access is paused, so
  // "here's a week while you sort the card out" is a real support action and
  // the days are genuine. It scans the whole history,
  // which matters — findActiveEntitlement returns a single row ordered by end
  // date, so an earlier comp stacked past the renewal would hide the very
  // subscription this check exists to find.
  const overview = await getBillingOverview(db, params.userId, productKey)

  const blockedBy = overview.accessSubscriptionIds[0]
  if (blockedBy) {
    return {
      outcome: 'active_subscription',
      refs: [],
      passes,
      days: 0,
      endsAt: null,
      stackedOn: null,
      blockedBy,
    }
  }

  // What they had before the first pass landed. Read up front because every
  // pass stacks on the one before it, and by the end the original expiry is no
  // longer recoverable from the table.
  // The shared rule, not a second copy of it — referral grants stack with the
  // same helper (server/utils/entitlements.ts › stackingBase), and "nobody
  // loses days they already have" must not be able to differ between two ways
  // of granting.
  const stackedOn = stackingBase(overview.active, now)

  // ── One batch, not N sequential inserts ────────────────────────────────────
  // The loop this replaces called grantPass() per pass, each re-reading the row
  // the last one wrote. With no transaction around it, a failure at pass 3 of 5
  // left two passes granted and threw — and the handler's catch told the
  // operator "Nothing changed on this account", which was simply untrue.
  //
  // Precomputing the dates makes the whole grant one atomic D1 batch: it either
  // all lands or none of it does, so the failure message can be honest. The
  // arithmetic is passEndDates() in entitlements.ts — the same function
  // grantPass uses for its single pass, so the stacking rule still exists once.
  const ends = passEndDates(stackedOn ?? now, passes)
  // Each pass opens where the one below it closes, and the first opens at the
  // stacking base — the same arithmetic `ends` is built from, read one step
  // earlier. Stored per row because the clawback measures a window from it; see
  // `period_start` in server/db/schema.ts.
  const starts = [toSeconds(stackedOn ?? now), ...ends.slice(0, -1)]

  const statements = refs.map((ref, index) =>
    db
      .insert(tables.entitlements)
      .values({
        userId: params.userId,
        paddleSubscriptionId: ref,
        productKey,
        status: 'active',
        periodStart: starts[index]!,
        currentPeriodEnd: ends[index]!,
      })
      // Same idempotency as a purchased pass: the unique ref means a replay
      // touches updated_at and nothing else. Comp refs are freshly minted UUIDs
      // so this should never fire — it is here so a retried request cannot
      // double-grant.
      .onConflictDoUpdate({
        target: tables.entitlements.paddleSubscriptionId,
        set: { updatedAt: new Date() },
      }),
  )

  // drizzle types batch as a non-empty tuple; `passes >= 1` is enforced above,
  // so the array is never empty and the assertion is safe.
  await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]])

  return {
    outcome: 'granted',
    refs,
    passes,
    days: passes * PASS_DAYS,
    endsAt: ends[ends.length - 1]!,
    stackedOn,
  }
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
  /**
   * The comp's window closed on its own. Nothing to revoke, and nothing is
   * written — see the note in revokeCompPass about why this is not "revoke it
   * anyway".
   */
  | 'already_expired'

export interface RevokeCompParams {
  /** The owner. Part of the WHERE, so a ref alone cannot reach another account. */
  userId: string
  /** The `comp_…` ref to take back. */
  ref: string
  now?: Date
  /**
   * The row, when the caller has already fetched it (the endpoint does, to
   * build its audit metadata). Saves a second identical read; the guarded
   * UPDATE below still re-asserts every condition, so passing a stale row
   * cannot revoke something it shouldn't.
   */
  row?: Pick<Entitlement, 'currentPeriodEnd' | 'status' | 'productKey'>
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
 *
 * ── An already-expired comp is left completely alone ────────────────────────
 * Nothing flips a comp's status when its window closes — it simply stops
 * matching the date half of findActiveEntitlement, so an expired comp still
 * reads `status: 'active'`. Revoking one used to set `current_period_end = now`
 * unconditionally, which moved a date that was months in the PAST forward to
 * today. That is backwards in the only direction that matters: it rewrites
 * history to say the customer had access for longer than they did, and on a row
 * that was granting nothing to begin with. `already_expired` writes nothing.
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

  const row =
    params.row ??
    (await db.query.entitlements.findFirst({
      where: and(
        eq(tables.entitlements.paddleSubscriptionId, ref),
        // Scoped to the owner, so a ref from one account cannot revoke on another.
        eq(tables.entitlements.userId, userId),
      ),
    }))
  if (!row) return { outcome: 'not_found', ref }

  // Status first, then the window — a revoke sets BOTH, so a second call would
  // otherwise report the more misleading of two true things ("it expired on its
  // own" for a row a person deliberately ended).
  if (!ACTIVE_STATUSES.includes(row.status)) {
    return { outcome: 'already_revoked', ref }
  }

  // Its window already closed, so there is no access to take away — and writing
  // `current_period_end = now` here would drag a past date forward. See above.
  if (row.currentPeriodEnd && row.currentPeriodEnd <= now) {
    return { outcome: 'already_expired', ref, revokedEndsAt: row.currentPeriodEnd }
  }

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
