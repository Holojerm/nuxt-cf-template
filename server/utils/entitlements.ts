// Entitlement writes — the money-critical half of billing.
//
// Every function here takes the Drizzle client as its first argument instead
// of reaching for the auto-imported `db`. That's deliberate: it lets the
// workerd vitest suite (test/entitlements.test.ts) drive this logic against a
// real D1 binding without booting Nitro, so refunds, stacking, and idempotency
// are covered by tests rather than by hope.
//
// Two entitlement shapes share the table, told apart by the Paddle ref stored
// in `paddle_subscription_id`:
//   - `sub_…` — auto-renewing subscription; Paddle's status lifecycle is the
//     source of truth.
//   - `txn_…` — one-time 30-day pass; no lifecycle events ever fire for it, so
//     it grants access only while current_period_end is in the future.

import { and, desc, eq, gt, inArray, isNotNull, or } from 'drizzle-orm'
import { z } from 'zod'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { Entitlement } from '../db/schema'
// Explicit, not the Nitro auto-import: the workerd vitest suite loads this file
// directly and nothing is injected there.
import { likePrefix } from './sql'
import { SUBSCRIPTION_REF_PREFIX, isSubscriptionRef } from './paddle-refs'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type EntitlementDb = ReturnType<typeof drizzle<typeof tables>>

/** Statuses that grant access. `past_due` is grace-period territory — excluded. */
export const ACTIVE_STATUSES = ['active', 'trialing']

/** Days of access granted by a one-time pass purchase. */
export const PASS_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * D1 timestamp columns hold epoch SECONDS — round-trips lose sub-second precision.
 *
 * Exported because every writer of an expiry date has to truncate the same way:
 * an untruncated value never equals what was stored, which makes the
 * "did this insert conflict?" comparison in grantPass — and in the referral
 * grants that copy its shape — read every write as a redelivery.
 */
export function toSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
}

/**
 * The stacking rule, as pure arithmetic: the end date of each of `passes`
 * consecutive passes laid end-to-end from `base`.
 *
 * Exported so admin-grants.ts can precompute a whole multi-pass comp and write
 * it in ONE atomic D1 batch, instead of looping N sequential inserts where a
 * failure at pass 3 of 5 leaves the account in a state no caller can describe.
 * Precomputing means the arithmetic exists outside grantPass — so it lives
 * here, once, and grantPass uses it too. A second copy of "how days stack"
 * would diverge from this one the first time PASS_DAYS moved, and the symptom
 * would be customers with the wrong expiry and no way to tell which path wrote
 * it.
 *
 * Whole seconds, because that is D1's resolution for a timestamp column: an
 * untruncated value never equals what was stored, which makes the redelivery
 * check in grantPass read every insert as a conflict.
 */
export function passEndDates(base: Date, passes: number): Date[] {
  return Array.from({ length: passes }, (_, index) =>
    toSeconds(new Date(base.getTime() + (index + 1) * PASS_DAYS * DAY_MS)),
  )
}

/**
 * The expiry a new grant should stack on top of, or null to start today.
 *
 * One line, extracted because it existed twice — here for referral grants and
 * in admin-grants.ts for comps — and "nobody loses days they already paid for"
 * is a rule that must not be able to differ between two ways of granting.
 * `passEndDates` above is the other half of the same arithmetic.
 *
 * The `> now` test is what makes an EXPIRED row stack from today rather than
 * from a date in the past, which would grant days that had already elapsed.
 */
export function stackingBase(
  granting: { currentPeriodEnd: Date | null } | null | undefined,
  now: Date,
): Date | null {
  const running = granting?.currentPeriodEnd
  return running && running > now ? running : null
}

/** Statuses we write when access is taken away for a money reason. */
export const REVOKED_STATUS = { refund: 'refunded', chargeback: 'chargeback' } as const

/**
 * Status written when a DERIVED entitlement is taken back — one whose existence
 * depended on another row's purchase (see `entitlements.earned_from_ref`).
 *
 * Deliberately the same word as admin-grants.ts's COMP_REVOKED_STATUS and NOT
 * one of REVOKED_STATUS's: `refunded` and `chargeback` describe money moving
 * back to a customer, and nobody ever paid for a derived row. /account renders
 * one `revoked` badge for both, and a second spelling would surface a status
 * word the UI has never seen. test/referral.test.ts pins the two together.
 *
 * Nothing has to learn this string to respect it: access is decided by the
 * ACTIVE_STATUSES allowlist, so any status outside it stops granting by
 * construction.
 */
export const DERIVED_REVOKED_STATUS = 'revoked'

/**
 * Statuses in which a `sub_` row will never charge a card again.
 *
 * ── Not the same question as ACTIVE_STATUSES, and the difference is money ────
 * ACTIVE_STATUSES answers "does this grant access right now" — an ACCESS rule,
 * which is why `past_due` is absent from it (a lapsed card should not keep the
 * product open). Whether Paddle will bill again is a different question with a
 * different answer for the same row: `past_due` and `paused` are precisely the
 * states that RESUME billing, one after a dunning retry succeeds and one when
 * the customer unpauses.
 *
 * Reading the access rule as the billing rule is how a deletion guard lets
 * someone delete an account out from under a subscription that then renews
 * against a card nobody can look up anymore. So the billing-liveness test is
 * stated as the complement: anything not terminal is live.
 */
export const BILLING_TERMINAL_STATUSES = [
  'canceled',
  REVOKED_STATUS.refund,
  REVOKED_STATUS.chargeback,
] as const

/** The two columns billing-liveness reads. Widened from `Entitlement` so callers
 *  can pass a projection instead of a whole row. */
export interface BillingLivenessRow {
  status: string
  scheduledChangeAction?: string | null
}

/**
 * Will Paddle ever bill this subscription row again?
 *
 * Two conditions, and the second is the one that reads as a bug when it is
 * missing. A status of `active` with `scheduled_change: { action: 'cancel' }`
 * is what Paddle stores for the entire notice period after somebody cancels —
 * they keep access until the date, and the status does not move until then. So
 * "status is not terminal" alone reported a cancelled subscription as live for
 * up to a year, and the deletion guard told those customers to go and cancel a
 * subscription they had already cancelled.
 *
 * A scheduled `pause` still bills afterwards and a `resume` obviously does, so
 * only `cancel` counts. An unrecognised action is treated as still-live, which
 * is the safe direction: the failure it protects against is deleting an account
 * out from under a card that then gets charged.
 */
export function isBillingLive(row: BillingLivenessRow): boolean {
  if ((BILLING_TERMINAL_STATUSES as readonly string[]).includes(row.status)) return false
  if (row.scheduledChangeAction === 'cancel') return false
  return true
}

/** The user's granting entitlement for a product, or null. */
export async function findActiveEntitlement(
  db: EntitlementDb,
  userId: string,
  productKey = 'default',
): Promise<Entitlement | null> {
  const row = await db.query.entitlements.findFirst({
    where: and(
      eq(tables.entitlements.userId, userId),
      eq(tables.entitlements.productKey, productKey),
      inArray(tables.entitlements.status, ACTIVE_STATUSES),
      or(
        // Escaped, because `_` is a LIKE wildcard: the obvious
        // `like(col, 'sub_%')` also matches `subs_fake`, and the `sub_` branch
        // is the one that grants access WITHOUT checking the expiry date.
        likePrefix(tables.entitlements.paddleSubscriptionId, SUBSCRIPTION_REF_PREFIX),
        gt(tables.entitlements.currentPeriodEnd, new Date()),
      ),
    ),
    orderBy: desc(tables.entitlements.currentPeriodEnd),
  })
  return row ?? null
}

export interface GrantPassParams {
  userId: string
  /** Paddle transaction id (`txn_…`) — the row's unique Paddle ref. */
  transactionId: string
  customerId?: string | null
  productKey?: string
  /** When Paddle billed the transaction; defaults to now. */
  billedAt?: Date
}

export interface GrantPassResult {
  /** false when this transaction was already recorded (webhook redelivery). */
  granted: boolean
  /** Whether the pass stacked on top of unexpired access or started today. */
  stackedOn: Date | null
  endsAt: Date
}

/**
 * Record a one-time pass purchase.
 *
 * Stacking rule: buying a second pass while one is still running EXTENDS from
 * the current expiry, never from the purchase date — nobody loses days they
 * already paid for. (Stated on /pricing so the behaviour isn't a surprise.)
 * Each pass stays its own row, so refunding one leaves the others alone;
 * the accepted rough edge is that refunding an *earlier* stacked pass doesn't
 * pull the later one's window back.
 *
 * Idempotent: Paddle redelivers webhooks, and the unique index on the Paddle
 * ref means a redelivery updates `updated_at` and nothing else.
 */
export async function grantPass(
  db: EntitlementDb,
  params: GrantPassParams,
): Promise<GrantPassResult> {
  const { userId, transactionId, customerId = null, productKey = 'default' } = params
  const billedAt = params.billedAt ?? new Date()

  const existing = await findActiveEntitlement(db, userId, productKey)
  const runningUntil =
    existing?.currentPeriodEnd && existing.currentPeriodEnd > billedAt
      ? existing.currentPeriodEnd
      : null
  // One pass laid on the running expiry — the same arithmetic a multi-pass comp
  // grant uses, so the two can never disagree about a stacking date.
  const endsAt = passEndDates(runningUntil ?? billedAt, 1)[0]!

  const inserted = await db
    .insert(tables.entitlements)
    .values({
      userId,
      paddleCustomerId: customerId,
      paddleSubscriptionId: transactionId, // the column holds the Paddle ref, txn_ or sub_
      productKey,
      status: 'active',
      currentPeriodEnd: endsAt,
    })
    .onConflictDoUpdate({
      target: tables.entitlements.paddleSubscriptionId,
      set: { updatedAt: new Date() },
    })
    .returning({ currentPeriodEnd: tables.entitlements.currentPeriodEnd })

  const stored = inserted[0]?.currentPeriodEnd ?? endsAt
  return {
    granted: stored.getTime() === endsAt.getTime(),
    stackedOn: runningUntil,
    endsAt: stored,
  }
}

export interface UpsertSubscriptionParams {
  userId: string
  subscriptionId: string
  customerId?: string | null
  productKey?: string
  status: string
  currentPeriodEnd?: Date | null
  /**
   * Paddle's pending cancel/pause/resume, or null when there isn't one.
   *
   * Explicitly nullable rather than optional-and-omitted: `null` is a fact the
   * upsert has to write (see the note there), not an absence it may skip.
   */
  scheduledChange?: { action: string; effectiveAt: Date | null } | null
}

export interface UpsertSubscriptionResult {
  /** The status this row held before the event, or null if it's brand new. */
  previousStatus: string | null
}

/**
 * Upsert the entitlement behind an auto-renewing subscription. Every
 * `subscription.*` event carries the full entity, so one upsert keyed on the
 * subscription id keeps status + period end current.
 *
 * Reports the prior status because Paddle sends a `subscription.updated` for
 * every trivial change (a card edit, a metadata tweak). The webhook emails on
 * *transitions* — active → past_due, new → active — and a caller that can't see
 * the old status has to either skip the emails or send duplicates.
 */
export async function upsertSubscription(
  db: EntitlementDb,
  params: UpsertSubscriptionParams,
): Promise<UpsertSubscriptionResult> {
  const prior = await db.query.entitlements.findFirst({
    where: eq(tables.entitlements.paddleSubscriptionId, params.subscriptionId),
    columns: { status: true },
  })

  const values = {
    userId: params.userId,
    paddleCustomerId: params.customerId ?? null,
    paddleSubscriptionId: params.subscriptionId,
    productKey: params.productKey ?? 'default',
    status: params.status,
    currentPeriodEnd: params.currentPeriodEnd ?? null,
    // `?? null`, never a conditional spread. Every subscription.* event carries
    // the full entity, so an absent scheduled_change means there is no longer
    // one — writing null is how "the customer un-cancelled" gets recorded.
    // Omitting the key on update would leave the old value in place and keep a
    // live subscription looking cancelled for good.
    scheduledChangeAction: params.scheduledChange?.action ?? null,
    scheduledChangeAt: params.scheduledChange?.effectiveAt ?? null,
  }
  await db
    .insert(tables.entitlements)
    .values(values)
    .onConflictDoUpdate({
      target: tables.entitlements.paddleSubscriptionId,
      set: {
        status: values.status,
        currentPeriodEnd: values.currentPeriodEnd,
        paddleCustomerId: values.paddleCustomerId,
        scheduledChangeAction: values.scheduledChangeAction,
        scheduledChangeAt: values.scheduledChangeAt,
        updatedAt: new Date(),
      },
    })

  return { previousStatus: prior?.status ?? null }
}

/** The adjustment fields we care about (Paddle `adjustment.created|updated`). */
export interface AdjustmentInput {
  action: string
  status?: string | null
  /** `full` or `partial` — recorded, but both revoke (see policy note below). */
  type?: string | null
  transactionId?: string | null
  subscriptionId?: string | null
}

export type RevokeOutcome =
  | 'revoked'
  | 'no_matching_entitlement'
  | 'action_not_revoking'
  | 'status_not_final'
  /** A chargeback the merchant won. Derived rows are put back; see below. */
  | 'reversed'

/** One derived row the cascade touched, with what it needs to be audited. */
export interface DerivedChange {
  ref: string
  userId: string
  /** The window as it stood before this change — the revoked or restored date. */
  periodEnd: Date | null
}

export interface RevokeResult {
  outcome: RevokeOutcome
  userId?: string
  paddleRef?: string
  /**
   * Rows that existed BECAUSE of this purchase and were revoked or restored
   * alongside it. Empty on every ordinary adjustment.
   *
   * Reported rather than silently written so a caller can audit it — the data
   * change is guaranteed for every caller (it happens inside this function),
   * the audit row is the caller's to write, because audit.ts's writer is not
   * something the money path should be able to fail on.
   */
  derived?: DerivedChange[]
}

/**
 * Does this adjustment mean the customer's money went back?
 *
 * - `refund` only counts once Paddle has APPROVED it. Refunds land as
 *   `pending_approval` first, and yanking access before approval would punish
 *   people whose refund is later rejected.
 * - `chargeback` counts immediately: the bank has already pulled the funds.
 *   Only an explicit reject/reverse takes it back off the table.
 * - `credit`, `chargeback_warning`, and the `*_reverse` actions never revoke.
 */
function isRevoking({ action, status }: AdjustmentInput): boolean {
  if (action === 'refund') return status === 'approved'
  if (action === 'chargeback') return status !== 'rejected' && status !== 'reversed'
  return false
}

/**
 * Did the money actually, fully go back?
 *
 * A separate question from isRevoking(), and the difference is the whole reason
 * derived rows need their own test. The customer's OWN access ends on any
 * approved refund, full or partial — a deliberate policy stated on /legal/refunds
 * and in revokeForAdjustment below, because we sell one indivisible thing and
 * pro-rating it would be a worse rule than a predictable one.
 *
 * A referral reward cannot inherit that. A $2 goodwill credit on a $120 annual
 * subscription is a support gesture, not a reversal of the sale, and it would
 * have permanently destroyed a reward somebody genuinely earned — for a
 * subscriber-referrer, a window that could be a year long. So a derived row is
 * only clawed back when the purchase behind it was undone in full, or when a
 * bank pulled the funds.
 */
function isFullReversal({ action, type }: AdjustmentInput): boolean {
  if (action === 'chargeback') return true
  if (action === 'refund') return type === 'full'
  return false
}

/**
 * Is this the bank giving the money BACK — a chargeback the merchant won?
 *
 * Paddle spells it two ways and both have to count: a distinct
 * `chargeback_reverse` action, and a `chargeback` carrying `status: 'reversed'`.
 * Neither reaches isRevoking(), which is correct for the customer's own row,
 * and which is exactly why a reversal used to leave the REFERRER revoked
 * forever on a dispute the merchant went on to win.
 */
function isReversing({ action, status }: AdjustmentInput): boolean {
  if (action === 'chargeback_reverse') return true
  return action === 'chargeback' && status === 'reversed'
}

/**
 * Revoke every row that exists because of `earningRef`'s purchase.
 *
 * Today that is exactly the referral rewards paid for it. The cascade lives
 * here, inside the entitlements layer, rather than in the webhook route or in
 * referral.ts, for two reasons:
 *
 *   * It is pure entitlements-table work. `earned_from_ref` is a column on this
 *     table, so nothing about it needs to know what a referral is — which also
 *     keeps referral.ts → entitlements.ts a one-way import instead of a cycle.
 *   * It has to be unmissable. Wired into the webhook route it protected one
 *     caller; wired into revokeForAdjustment it protects every caller there
 *     will ever be, including the admin tooling somebody adds later.
 *
 * A `sub_` row is skipped even if something ever tags one: Paddle owns those,
 * and a local status written onto one is either overwritten by the next webhook
 * or takes away access the customer paid for.
 */
export async function revokeDerivedEntitlements(
  db: EntitlementDb,
  earningRef: string,
  now: Date = new Date(),
): Promise<DerivedChange[]> {
  const rows = await db.query.entitlements.findMany({
    where: and(
      eq(tables.entitlements.earnedFromRef, earningRef),
      inArray(tables.entitlements.status, ACTIVE_STATUSES),
    ),
  })

  const changed: DerivedChange[] = []
  for (const row of rows) {
    if (isSubscriptionRef(row.paddleSubscriptionId)) continue
    // Its window already closed, so there is nothing to take away — and
    // writing `current_period_end = now` here would drag a PAST date forward,
    // rewriting history to say the holder had access longer than they did.
    // It also gives the policy a sensible edge for free: a chargeback on month
    // seven finds a reward whose days were spent long ago and leaves it alone.
    if (row.currentPeriodEnd && row.currentPeriodEnd <= now) continue

    const updated = await db
      .update(tables.entitlements)
      .set({
        status: DERIVED_REVOKED_STATUS,
        // Both halves, so the status allowlist and anything reading only the
        // window (the MCP worker's raw SQL) can never disagree.
        currentPeriodEnd: now,
        // What the restore puts back. Also the flag the restore matches on.
        restorePeriodEnd: row.currentPeriodEnd,
        updatedAt: new Date(),
      })
      // Re-asserted rather than trusted from the read: two adjustment
      // deliveries in flight both pass the scan, only one matches here, and the
      // loser writes nothing instead of stamping a second expiry over the first
      // — which would also overwrite restore_period_end with the revoked date
      // and make the row unrestorable.
      .where(
        and(
          eq(tables.entitlements.id, row.id),
          inArray(tables.entitlements.status, ACTIVE_STATUSES),
        ),
      )
      .returning({ id: tables.entitlements.id })

    if (updated.length) {
      changed.push({
        ref: row.paddleSubscriptionId,
        userId: row.userId,
        periodEnd: row.currentPeriodEnd,
      })
    }
  }
  return changed
}

/**
 * Put back every derived row this purchase's reversal should restore.
 *
 * Matched on `restore_period_end IS NOT NULL`, which is set by nothing but the
 * revoke above — so this can only ever undo a cascade, never resurrect a row
 * that expired on its own or one an operator ended deliberately.
 *
 * The restored window is the ORIGINAL end, not `now + what was left`. The
 * reward was for a purchase that, it turns out, stood; the honest thing is the
 * window they would have had. If that date has since passed, the row restores
 * as expired, which is the truth rather than a consolation.
 *
 * Note the deliberate asymmetry: this restores the REFERRER's derived row and
 * not the referee's own entitlement. Paddle owns that one, and it comes back
 * through Paddle's own events; reaching around the billing system to re-grant
 * access on a dispute is exactly what revokeCompPass refuses to do.
 */
export async function restoreDerivedEntitlements(
  db: EntitlementDb,
  earningRef: string,
): Promise<DerivedChange[]> {
  const rows = await db.query.entitlements.findMany({
    where: and(
      eq(tables.entitlements.earnedFromRef, earningRef),
      isNotNull(tables.entitlements.restorePeriodEnd),
    ),
  })

  const changed: DerivedChange[] = []
  for (const row of rows) {
    const restored = await db
      .update(tables.entitlements)
      .set({
        status: 'active',
        currentPeriodEnd: row.restorePeriodEnd,
        // Cleared, so the row is no longer "revoked and restorable" — a second
        // reversal delivery finds nothing to do rather than re-restoring.
        restorePeriodEnd: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(tables.entitlements.id, row.id), isNotNull(tables.entitlements.restorePeriodEnd)),
      )
      .returning({ id: tables.entitlements.id })

    if (restored.length) {
      changed.push({
        ref: row.paddleSubscriptionId,
        userId: row.userId,
        periodEnd: row.restorePeriodEnd,
      })
    }
  }
  return changed
}

/**
 * Revoke the entitlement a refund/chargeback belongs to.
 *
 * Policy: ANY approved refund ends access, full or partial. We sell one
 * indivisible thing at one price, partial refunds are a manual goodwill
 * action, and /legal/refunds says exactly this — so a predictable rule beats
 * pro-rating.
 *
 * Matching: a pass's row is keyed by the transaction id; a subscription's row
 * by the subscription id. Try the transaction first, then the subscription.
 * (Refunding one month of a still-live subscription revokes now, but the next
 * `subscription.*` event will legitimately restore it — Paddle's status stays
 * the source of truth for subs.)
 */
export async function revokeForAdjustment(
  db: EntitlementDb,
  adjustment: AdjustmentInput,
): Promise<RevokeResult> {
  const refs = [adjustment.transactionId, adjustment.subscriptionId].filter((r): r is string =>
    Boolean(r),
  )

  // ── A chargeback the merchant WON ──────────────────────────────────────────
  // Handled before the revoking tests, because it reaches neither of them: a
  // reversal is not an action that revokes and not a status that is final, so
  // it used to fall straight out of this function. That left every derived row
  // revoked forever on a dispute that went our way — money taken back from a
  // referrer over a chargeback that never stood.
  if (isReversing(adjustment)) {
    const derived: DerivedChange[] = []
    for (const ref of refs) derived.push(...(await restoreDerivedEntitlements(db, ref)))
    return { outcome: 'reversed', derived }
  }

  if (adjustment.action !== 'refund' && adjustment.action !== 'chargeback') {
    return { outcome: 'action_not_revoking' }
  }
  if (!isRevoking(adjustment)) return { outcome: 'status_not_final' }

  // Computed once, before the loop: whether derived rows come down with this
  // adjustment is a property of the ADJUSTMENT, not of which ref matched.
  const full = isFullReversal(adjustment)
  const now = new Date()

  for (const ref of refs) {
    const revoked = await db
      .update(tables.entitlements)
      .set({
        status: REVOKED_STATUS[adjustment.action],
        // Expire the window too: anything that only checks the date (the MCP
        // worker's raw SQL gate, a future report) must agree with the status.
        currentPeriodEnd: now,
        updatedAt: new Date(),
      })
      .where(eq(tables.entitlements.paddleSubscriptionId, ref))
      .returning({ userId: tables.entitlements.userId })
    const row = revoked[0]
    if (row) {
      // Anything that existed because of THIS purchase comes down with it —
      // but only on a full reversal, and only for this ref. Keying the cascade
      // on the purchase rather than on the buyer is what stops a refund of
      // somebody's second pass from clawing back the reward their first one
      // earned. See isFullReversal and revokeDerivedEntitlements.
      const derived = full ? await revokeDerivedEntitlements(db, ref, now) : []
      return { outcome: 'revoked', userId: row.userId, paddleRef: ref, derived }
    }
  }
  return { outcome: 'no_matching_entitlement' }
}

// ─── Webhook event → entitlement ────────────────────────────────────────────
// The shape of the Paddle events we act on, and the dispatcher that turns one
// into entitlement writes. Kept out of the route handler so the vitest suite
// can drive real events against a real D1 without booting Nitro; the route
// (server/routes/paddle/webhook.post.ts) does signature checking, calls this,
// and reports the result to PostHog.

export const paddleEventSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    status: z.string().nullish(),
    customer_id: z.string().nullish(),
    subscription_id: z.string().nullish(),
    billed_at: z.string().nullish(),
    custom_data: z
      .object({ userId: z.string().optional(), productKey: z.string().optional() })
      .nullish(),
    current_billing_period: z.object({ ends_at: z.string() }).nullish(),
    // subscription.* only. Present and populated while a cancel/pause/resume is
    // pending, and explicitly `null` once it is applied or withdrawn — which is
    // why `.nullish()` matters here more than anywhere else in this schema: the
    // null IS the signal that a scheduled cancel was called off, and dropping
    // it would leave a live subscription looking cancelled forever.
    scheduled_change: z
      .object({ action: z.string(), effective_at: z.string().nullish() })
      .nullish(),
    // adjustment.* only — refunds, credits, chargebacks. Note there is no
    // custom_data on an adjustment, so these events are matched to a user
    // through the transaction/subscription id we already stored.
    action: z.string().nullish(),
    type: z.string().nullish(),
    transaction_id: z.string().nullish(),
  }),
})

export type PaddleEvent = z.infer<typeof paddleEventSchema>

export type PaddleEventOutcome =
  | { kind: 'subscription'; userId: string; status: string; previousStatus: string | null }
  | { kind: 'pass'; userId: string; granted: boolean; endsAt: Date; stackedOn: Date | null }
  | { kind: 'adjustment'; action: string; result: RevokeResult }
  | { kind: 'ignored'; reason: 'no_user' | 'subscription_transaction' | 'unhandled_event' }

/** Apply one verified Paddle event to the entitlements table. */
export async function applyPaddleEvent(
  db: EntitlementDb,
  event: PaddleEvent,
): Promise<PaddleEventOutcome> {
  const { event_type: eventType, data } = event
  const userId = data.custom_data?.userId
  const productKey = data.custom_data?.productKey ?? 'default'

  if (eventType.startsWith('subscription.')) {
    // Not fatal: a subscription created outside the app (e.g. a dashboard test)
    // has no userId to map back to.
    if (!userId) return { kind: 'ignored', reason: 'no_user' }
    const status = data.status ?? 'unknown'
    const { previousStatus } = await upsertSubscription(db, {
      userId,
      subscriptionId: data.id,
      customerId: data.customer_id,
      productKey,
      status,
      currentPeriodEnd: data.current_billing_period
        ? new Date(data.current_billing_period.ends_at)
        : null,
      scheduledChange: data.scheduled_change
        ? {
            action: data.scheduled_change.action,
            effectiveAt: data.scheduled_change.effective_at
              ? new Date(data.scheduled_change.effective_at)
              : null,
          }
        : null,
    })
    return { kind: 'subscription', userId, status, previousStatus }
  }

  if (eventType === 'transaction.completed') {
    if (!userId) return { kind: 'ignored', reason: 'no_user' }
    // A completed transaction WITH a subscription attached is a renewal — the
    // subscription.* events above own that entitlement.
    if (data.subscription_id) return { kind: 'ignored', reason: 'subscription_transaction' }
    const result = await grantPass(db, {
      userId,
      transactionId: data.id,
      customerId: data.customer_id,
      productKey,
      billedAt: data.billed_at ? new Date(data.billed_at) : undefined,
    })
    return { kind: 'pass', userId, ...result }
  }

  if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
    const action = data.action ?? 'unknown'
    const result = await revokeForAdjustment(db, {
      action,
      status: data.status,
      type: data.type,
      transactionId: data.transaction_id,
      subscriptionId: data.subscription_id,
    })
    return { kind: 'adjustment', action, result }
  }

  return { kind: 'ignored', reason: 'unhandled_event' }
}

// ─── Billing-page queries ───────────────────────────────────────────────────

export interface BillingOverview {
  /** The entitlement currently granting access, if any. */
  active: Entitlement | null
  /**
   * Auto-renewing subscriptions (`sub_…`) that can still charge the customer.
   *
   * "Can still charge" — NOT "grants access". They are different sets during
   * dunning and while paused, and conflating them produced a product that
   * contradicted itself: on the access rule a `past_due` customer was shown
   * `cancellable: 0`, handed a portal link with no subscription ids in it, and
   * then refused account deletion with "cancel it in the portal first".
   *
   * This is the set for anything about MONEY: what a cancel link targets, what
   * blocks deletion. For anything about ACCESS, use `accessSubscriptionIds`.
   */
  cancellableSubscriptionIds: string[]
  /**
   * Subscriptions currently granting access (ACTIVE_STATUSES).
   *
   * The set for anything about entitlement rather than billing — chiefly
   * whether a comp would be redundant. During dunning access is already paused,
   * so "here's a week while you sort the card out" is a real support action and
   * a comp granted then is genuinely worth its days; blocking it because the
   * subscription can still bill would be answering the wrong question.
   */
  accessSubscriptionIds: string[]
  /** Most recent Paddle customer id seen for this user, for portal links. */
  paddleCustomerId: string | null
  /** Every entitlement row, newest first — the "billing history" list. */
  history: Entitlement[]
}

/**
 * Everything the account/billing page needs in one query: what's granting
 * access now, what can be cancelled, and the Paddle customer to open a portal
 * session for. Includes ended rows on purpose — a lapsed customer still needs
 * their receipts and their "your access ended on …" line.
 */
export async function getBillingOverview(
  db: EntitlementDb,
  userId: string,
  productKey = 'default',
): Promise<BillingOverview> {
  const history = await db.query.entitlements.findMany({
    where: and(
      eq(tables.entitlements.userId, userId),
      eq(tables.entitlements.productKey, productKey),
    ),
    orderBy: desc(tables.entitlements.createdAt),
  })
  const active = await findActiveEntitlement(db, userId, productKey)
  return {
    active,
    // Both sets, built from the same scan, through the shared predicates rather
    // than a fourth hand-rolled `startsWith('sub_')`. Two fields rather than
    // one because callers genuinely need different answers — see the interface.
    cancellableSubscriptionIds: history
      .filter((e) => isSubscriptionRef(e.paddleSubscriptionId) && isBillingLive(e))
      .map((e) => e.paddleSubscriptionId),
    accessSubscriptionIds: history
      .filter(
        (e) => isSubscriptionRef(e.paddleSubscriptionId) && ACTIVE_STATUSES.includes(e.status),
      )
      .map((e) => e.paddleSubscriptionId),
    // Prefer the customer behind the LIVE entitlement — that's whose portal a
    // cancel link has to open. Fall back to any customer id we've ever seen so
    // a lapsed user can still reach their invoices.
    paddleCustomerId:
      active?.paddleCustomerId ?? history.find((e) => e.paddleCustomerId)?.paddleCustomerId ?? null,
    history,
  }
}
