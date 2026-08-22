// The referral loop — the half that moves money.
//
// A referral reward is access somebody did not pay for, granted automatically,
// on a signal that arrives from outside the building. That makes it billing
// code, and it is written like billing code: the db comes in as the first
// argument so test/referral.test.ts can drive real grants against a real D1
// inside workerd, every refusal is a named outcome rather than a silent return,
// and nothing here throws at its callers — one of which is the Paddle webhook,
// which must answer 200 or Paddle replays the money event behind it.
//
// ── The loop, and where each half can be gamed ───────────────────────────────
//   1. Every account gets a code (server/utils/users.ts, at provisioning) and a
//      link, /?ref=CODE.
//   2. A visitor arriving on that link has the code written into the SAME
//      first-touch attribution cookie the marketing columns come from
//      (shared/utils/attribution.ts). First touch wins, so a returning visitor
//      cannot be re-credited to whoever sent them the most recent link.
//   3. At account creation the code is resolved to a real, live, other account
//      and frozen into `users.referred_by`. Unresolvable codes are dropped.
//   4. The new account gets REFERRAL_WELCOME_DAYS immediately.
//   5. The REFERRER gets REFERRAL_REWARD_DAYS the first time that account
//      completes a Paddle transaction — never before.
//
// Step 5 is the whole anti-fraud design, and step 4 is why it has to be. A
// grant at signup costs its recipient one fresh mailbox; if the referrer were
// paid then too, N throwaway accounts would be an unbounded supply of free
// access to one person, and the product would be free to anyone patient. Tying
// the referrer's side to a completed transaction means farming the program
// costs strictly more than buying the product. The welcome grant is small for
// the same arithmetic run on the other side — see REFERRAL_WELCOME_DAYS.
//
// What this does NOT defend against: one person with two mailboxes paying once
// to give themselves 30 extra days. That is a $12–18 purchase for $18 of
// product, which is a bad trade for the attacker and a fine one for us, and the
// per-referrer cap bounds it anyway.
//
// ── Idempotency is structural, not a flag ────────────────────────────────────
// There is no ledger table and no "already paid?" column, because both would
// need a read-then-write that a webhook redelivery can race. Instead each grant
// derives a DETERMINISTIC ref (server/utils/paddle-refs.ts) from the account it
// concerns, and the unique index on `entitlements.paddle_subscription_id`
// refuses the second one. Five redeliveries compute one ref and write one row.

import { and, count, eq, isNull } from 'drizzle-orm'

import {
  REFERRAL_CODE_MINT_ATTEMPTS,
  REFERRAL_MAX_REWARDS,
  REFERRAL_REWARD_DAYS,
  REFERRAL_WELCOME_DAYS,
} from '#shared/utils/referral'
import * as tables from '../db/schema'
import type { User } from '../db/schema'
import { writeAudit } from './audit'
import { getBillingOverview, toSeconds } from './entitlements'
import type { EntitlementDb } from './entitlements'
import { REFERRAL_REF_PREFIX, referralRewardRef, referralWelcomeRef } from './paddle-refs'
import { likePrefix } from './sql'
import {
  findReferrerByCode,
  findUserById,
  generateReferralCode,
  isReferralCodeCollision,
} from './users'

const DAY_MS = 24 * 60 * 60 * 1000

/** The sentinel actor on an audit row nobody clicked. See server/utils/audit.ts. */
const SYSTEM_ACTOR = 'system'

// ─── Granting ────────────────────────────────────────────────────────────────

/** Which side of the loop a grant is for. Ends up in the audit metadata. */
export type ReferralSide = 'referee' | 'referrer'

export type ReferralGrantOutcome =
  /** Days written. */
  | 'granted'
  /** This exact ref already exists — a redelivery, or a second purchase. */
  | 'already_granted'
  /** Refused: a live subscription already grants access. See below. */
  | 'active_subscription'

export interface ReferralGrantPlan {
  ref: string
  days: number
  /** Truncated to whole seconds, because that is D1's resolution for a timestamp. */
  endsAt: Date
  /** The expiry these days were laid on top of, or null if access starts today. */
  stackedOn: Date | null
  productKey: string
  userId: string
}

/**
 * Work out what a grant would do, without writing anything.
 *
 * Split from the write so the caller can decide — and audit — before acting.
 * server/utils/audit.ts's policy is that the audit row describes intent and is
 * written first; a row saying "rewarded" in front of a grant that was about to
 * be refused would be the opposite of a record.
 *
 * ── Why a live subscriber is refused ─────────────────────────────────────────
 * Inherited verbatim from grantCompPasses(), for the same reason spelled out
 * there: days stack from the CURRENT expiry, and for a monthly subscriber that
 * expiry is the renewal their next payment already buys. The customer gains
 * nothing, and meanwhile the granted row outranks the subscription in
 * findActiveEntitlement's `ORDER BY current_period_end DESC`. Telling somebody
 * "you earned 30 days" while handing them zero is worse than telling them
 * nothing, so nothing is written and the skip is logged.
 *
 * `accessSubscriptionIds`, not `cancellableSubscriptionIds`: during dunning
 * access is genuinely paused, so referral days are genuinely days.
 */
async function planReferralGrant(
  db: EntitlementDb,
  params: { userId: string; ref: string; days: number; productKey?: string; now?: Date },
): Promise<{ ok: true; plan: ReferralGrantPlan } | { ok: false; blockedBy: string }> {
  const productKey = params.productKey ?? 'default'
  const now = params.now ?? new Date()

  // One read answers both questions: is a subscription already granting access
  // (refuse), and what is currently granting access (the stacking base). It
  // scans the whole history rather than trusting findActiveEntitlement's single
  // row, which an earlier grant stacked past a renewal would hide.
  const overview = await getBillingOverview(db, params.userId, productKey)

  const blockedBy = overview.accessSubscriptionIds[0]
  if (blockedBy) return { ok: false, blockedBy }

  const running = overview.active?.currentPeriodEnd
  const stackedOn = running && running > now ? running : null
  const base = stackedOn ?? now

  return {
    ok: true,
    plan: {
      ref: params.ref,
      days: params.days,
      endsAt: toSeconds(new Date(base.getTime() + params.days * DAY_MS)),
      stackedOn,
      productKey,
      userId: params.userId,
    },
  }
}

/**
 * Write one planned grant. Idempotent on the ref, by the unique index.
 *
 * `granted` is reported the way grantPass() reports it: compare what came back
 * from the upsert against what this call computed. On a redelivery the stored
 * date is whatever the first delivery wrote, the recomputed one has stacked on
 * top of it, and the two differ — so the flag is derived from the database's
 * answer rather than from a prior read that a race could have invalidated.
 */
async function writeReferralGrant(
  db: EntitlementDb,
  plan: ReferralGrantPlan,
): Promise<{ granted: boolean; endsAt: Date }> {
  const stored = await db
    .insert(tables.entitlements)
    .values({
      userId: plan.userId,
      paddleSubscriptionId: plan.ref,
      productKey: plan.productKey,
      status: 'active',
      currentPeriodEnd: plan.endsAt,
    })
    .onConflictDoUpdate({
      target: tables.entitlements.paddleSubscriptionId,
      set: { updatedAt: new Date() },
    })
    .returning({ currentPeriodEnd: tables.entitlements.currentPeriodEnd })

  const endsAt = stored[0]?.currentPeriodEnd ?? plan.endsAt
  return { granted: endsAt.getTime() === plan.endsAt.getTime(), endsAt }
}

/** One structured line per decision. Skips are the ones worth reading. */
function logReferral(kind: string, fields: Record<string, string | number | undefined>): void {
  console.warn(JSON.stringify({ kind, ...fields }))
}

// ─── The two payouts ─────────────────────────────────────────────────────────

export type ReferralOutcome =
  | ReferralGrantOutcome
  /** The account was not referred by anybody. The overwhelmingly common answer. */
  | 'no_referrer'
  /** `referred_by` names a code that no live account holds — deleted, or junk. */
  | 'referrer_unresolved'
  /** The referrer and the referee are the same account. */
  | 'self_referral'
  /** This referrer has earned REFERRAL_MAX_REWARDS already. */
  | 'capped'
  /** Something threw. Logged, swallowed, and safe to retry on redelivery. */
  | 'error'

export interface ReferralResult {
  outcome: ReferralOutcome
  /** The account credited, when one was. */
  referrerId?: string
  days?: number
  endsAt?: Date | null
  stackedOn?: Date | null
}

/**
 * Record one payout, then make it. Audit-before-act, per server/utils/audit.ts.
 *
 * Both sides share this tail because both are the same privileged event: the
 * system granting access nobody paid for. One `referral.rewarded` action with a
 * `side` in its metadata, rather than two actions, keeps "everything the
 * referral loop ever gave away" a single query.
 *
 * The audit row is written BEFORE the insert, which in the vanishing case of
 * two concurrent webhook redeliveries can leave two audit rows behind one
 * entitlement. That is the correct direction to fail: a record of an action
 * that partly did not happen is recoverable by reading the entitlements table,
 * an unrecorded grant is not.
 */
async function payReferral(
  db: EntitlementDb,
  plan: ReferralGrantPlan,
  context: { side: ReferralSide; refereeId: string; referrerId: string },
): Promise<ReferralResult> {
  await writeAudit(db, {
    actorUserId: SYSTEM_ACTOR,
    actorType: 'system',
    action: 'referral.rewarded',
    targetType: 'user',
    targetId: plan.userId,
    // Ids and numbers only — no addresses, no codes. An audit row outlives the
    // account it describes (see server/utils/audit.ts), and a referral code is
    // a shareable credential rather than a fact worth freezing forever.
    metadata: {
      side: context.side,
      days: plan.days,
      ref: plan.ref,
      refereeId: context.refereeId,
      referrerId: context.referrerId,
    },
  })

  const written = await writeReferralGrant(db, plan)
  return {
    outcome: written.granted ? 'granted' : 'already_granted',
    referrerId: context.referrerId,
    days: written.granted ? plan.days : 0,
    endsAt: written.endsAt,
    stackedOn: plan.stackedOn,
  }
}

/**
 * The referee's arrival bonus — REFERRAL_WELCOME_DAYS, at account creation.
 *
 * Called from establishSession() inside afterSignIn(), so it runs after the
 * session cookie is sealed and cannot fail a sign-in. It never throws anyway;
 * both guards exist because the cost of getting this wrong is that somebody's
 * account creation 500s over a free trial they did not ask for.
 *
 * Re-resolves the referrer rather than trusting `users.referred_by` to still
 * mean something. It was resolved moments ago on the same request, so this is
 * belt and braces — but it is one indexed read, it is the only place the
 * referrer's ID is available for the audit row, and "the claim was verified at
 * payout time" is a property worth having in code that hands out access.
 */
export async function grantRefereeWelcome(
  db: EntitlementDb,
  user: Pick<User, 'id' | 'email' | 'referredBy'>,
  options: { productKey?: string; now?: Date } = {},
): Promise<ReferralResult> {
  try {
    if (!user.referredBy) return { outcome: 'no_referrer' }

    // No `selfEmail` here, deliberately. That argument makes findReferrerByCode
    // fold "it's you" into "no such referrer", which is the right answer at
    // provisioning (there is no id yet to compare) and the wrong one here: the
    // two outcomes want different log lines, and "unresolved" sent somebody
    // looking for a deleted account that was never involved. The id comparison
    // below is the real gate, and it is exact.
    const referrer = await findReferrerByCode(db, user.referredBy)
    if (!referrer) {
      logReferral('referral_welcome_skipped', { reason: 'referrer_unresolved', userId: user.id })
      return { outcome: 'referrer_unresolved' }
    }
    if (referrer.id === user.id) {
      logReferral('referral_welcome_skipped', { reason: 'self_referral', userId: user.id })
      return { outcome: 'self_referral' }
    }

    const planned = await planReferralGrant(db, {
      userId: user.id,
      ref: referralWelcomeRef(user.id),
      days: REFERRAL_WELCOME_DAYS,
      productKey: options.productKey,
      now: options.now,
    })
    if (!planned.ok) {
      logReferral('referral_welcome_skipped', {
        reason: 'active_subscription',
        userId: user.id,
        blockedBy: planned.blockedBy,
      })
      return { outcome: 'active_subscription', referrerId: referrer.id }
    }

    return await payReferral(db, planned.plan, {
      side: 'referee',
      refereeId: user.id,
      referrerId: referrer.id,
    })
  } catch (error) {
    // A free trial is never worth failing an account creation over.
    logReferral('referral_welcome_failed', { userId: user.id, error: String(error) })
    return { outcome: 'error' }
  }
}

/**
 * The referrer's reward — REFERRAL_REWARD_DAYS, the first time their referee pays.
 *
 * Called from the Paddle webhook next to notifyBillingOutcome(), and bound by
 * the same contract: it never throws, and nothing it does may stop that handler
 * returning 200. A thrown error here would make Paddle replay a completed
 * transaction; a swallowed one costs a reward that the very next redelivery
 * repairs, because the whole function is idempotent and safe to re-run.
 *
 * Deliberately called on EVERY qualifying event rather than only on the first
 * one. "First purchase" is enforced by the deterministic ref, not by the
 * caller's ability to recognise a first purchase — so a redelivery is a repair
 * path rather than a double payout, and a customer's second pass pays nothing.
 */
export async function rewardReferrerForFirstPurchase(
  db: EntitlementDb,
  refereeId: string,
  options: { productKey?: string; now?: Date } = {},
): Promise<ReferralResult> {
  try {
    const referee = await findUserById(db, refereeId)
    if (!referee?.referredBy) return { outcome: 'no_referrer' }

    // Without `selfEmail` — see the note in grantRefereeWelcome above.
    const referrer = await findReferrerByCode(db, referee.referredBy)
    if (!referrer) {
      // Usually a deleted referrer: deletion nulls `referral_code`, so the claim
      // stops resolving and the reward stops being payable. That is deliberate
      // — a tombstone cannot earn — and it is worth a line, because it is also
      // what a hand-edited `referred_by` looks like.
      logReferral('referral_reward_skipped', { reason: 'referrer_unresolved', refereeId })
      return { outcome: 'referrer_unresolved' }
    }
    if (referrer.id === refereeId) {
      logReferral('referral_reward_skipped', { reason: 'self_referral', refereeId })
      return { outcome: 'self_referral' }
    }

    const ref = referralRewardRef(refereeId)

    // Checked up front so the audit row below is honest about what happened,
    // rather than recording a payout the unique index was always going to
    // refuse. The index is still the real guard — this read can be raced.
    const existing = await db.query.entitlements.findFirst({
      where: eq(tables.entitlements.paddleSubscriptionId, ref),
      columns: { id: true },
    })
    if (existing) return { outcome: 'already_granted', referrerId: referrer.id }

    const earned = await countReferralRewards(db, referrer.id)
    if (earned >= REFERRAL_MAX_REWARDS) {
      // Not a business rule being hit — a blast radius. At this volume somebody
      // should look, which is what the log line is for.
      logReferral('referral_reward_skipped', {
        reason: 'capped',
        refereeId,
        referrerId: referrer.id,
        earned,
      })
      return { outcome: 'capped', referrerId: referrer.id }
    }

    const planned = await planReferralGrant(db, {
      userId: referrer.id,
      ref,
      days: REFERRAL_REWARD_DAYS,
      productKey: options.productKey,
      now: options.now,
    })
    if (!planned.ok) {
      logReferral('referral_reward_skipped', {
        reason: 'active_subscription',
        refereeId,
        referrerId: referrer.id,
        blockedBy: planned.blockedBy,
      })
      return { outcome: 'active_subscription', referrerId: referrer.id }
    }

    return await payReferral(db, planned.plan, {
      side: 'referrer',
      refereeId,
      referrerId: referrer.id,
    })
  } catch (error) {
    logReferral('referral_reward_failed', { refereeId, error: String(error) })
    return { outcome: 'error' }
  }
}

// ─── Reading the loop back ───────────────────────────────────────────────────

/**
 * How many referees this account has already been rewarded for.
 *
 * Counts `referral_` rows only. A `welcome_` row belongs to the account's own
 * arrival and must not eat into the budget it earns with — which is the entire
 * reason the two grants carry different prefixes.
 *
 * Revoked and refunded reward rows still count. The cap bounds how many payouts
 * an account can trigger, not how many are currently granting access; making it
 * the latter would let a refund cycle reset the budget.
 */
export async function countReferralRewards(db: EntitlementDb, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(tables.entitlements)
    .where(
      and(
        eq(tables.entitlements.userId, userId),
        // Escaped, because `_` is a LIKE wildcard — see server/utils/sql.ts.
        likePrefix(tables.entitlements.paddleSubscriptionId, REFERRAL_REF_PREFIX),
      ),
    )
  return row?.total ?? 0
}

/**
 * Make sure this account has a code, minting one if it predates the column.
 *
 * `users.referral_code` is nullable precisely because backfilling would have
 * handed codes to dormant accounts that will never share one
 * (server/db/schema.ts). So the mint is lazy: it happens the first time
 * somebody actually opens the share card.
 *
 * The UPDATE is guarded on `referral_code IS NULL`, which makes two concurrent
 * requests safe without a transaction: one wins, the other matches no row and
 * reads back the winner's code. The retry loop around it handles the other
 * failure — a collision on the unique index — the same way provisioning does,
 * through the same predicate, because there is only one correct way to read
 * that error out of D1 (server/utils/users.ts › isReferralCodeCollision).
 */
export async function ensureReferralCode(
  db: EntitlementDb,
  userId: string,
  mintCode: () => string = generateReferralCode,
): Promise<string | null> {
  const existing = await db.query.users.findFirst({
    where: eq(tables.users.id, userId),
    columns: { referralCode: true },
  })
  if (!existing) return null
  if (existing.referralCode) return existing.referralCode

  for (let attempt = 1; attempt <= REFERRAL_CODE_MINT_ATTEMPTS; attempt++) {
    const code = mintCode()
    try {
      const [updated] = await db
        .update(tables.users)
        .set({ referralCode: code })
        .where(and(eq(tables.users.id, userId), isNull(tables.users.referralCode)))
        .returning({ referralCode: tables.users.referralCode })

      if (updated?.referralCode) return updated.referralCode

      // Matched nothing: a concurrent request minted first. Read theirs.
      const now = await db.query.users.findFirst({
        where: eq(tables.users.id, userId),
        columns: { referralCode: true },
      })
      return now?.referralCode ?? null
    } catch (error) {
      if (attempt === REFERRAL_CODE_MINT_ATTEMPTS || !isReferralCodeCollision(error)) throw error
    }
  }

  throw new Error('Referral code mint exhausted attempts')
}

export interface ReferralSummary {
  code: string
  /** Accounts created through this code. Not the same as rewarded. */
  referredCount: number
  /** Referees who went on to pay, i.e. rewards actually earned. */
  rewardedCount: number
}

/**
 * Everything the share card renders, in three reads.
 *
 * The two counts are deliberately both shown, because they answer different
 * questions and the gap between them is the honest part: "4 people joined, 1
 * has subscribed" is the truth about a referral program, and showing only the
 * first number sets up the support ticket that asks where the days are.
 */
export async function getReferralSummary(
  db: EntitlementDb,
  userId: string,
): Promise<ReferralSummary | null> {
  const code = await ensureReferralCode(db, userId)
  if (!code) return null

  const [referred] = await db
    .select({ total: count() })
    .from(tables.users)
    .where(eq(tables.users.referredBy, code))

  return {
    code,
    referredCount: referred?.total ?? 0,
    rewardedCount: await countReferralRewards(db, userId),
  }
}
