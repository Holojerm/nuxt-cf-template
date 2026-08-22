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
//   4. The new MAILBOX gets REFERRAL_WELCOME_DAYS, once, ever.
//   5. The REFERRER gets REFERRAL_REWARD_DAYS the first time that account pays
//      — and loses them again if that payment is refunded or charged back.
//
// ── What each half costs an attacker, stated honestly ────────────────────────
// This is the part that was wrong in the first version of this file, which
// claimed farming the loop "costs strictly more than buying the product". It
// did not, and the gap is worth writing down because it is the shape every
// referral program gets attacked through.
//
// The claim only holds if the money actually stays. It did not: a referee could
// buy the $18 pass, collect the referrer's 30 days, and refund the same day —
// so the true cost of 30 days was a refund request, repeated through `+1`,
// `+2`, `+3` sub-addresses of one inbox. Three things close that, and all three
// are needed:
//
//   * The reward is REVOKED when an adjustment revokes the referee's purchase
//     (revokeReferralRewardForReferee below). Refunded money buys nothing.
//   * The cap counts revoked rows too, so refund-churn burns budget rather than
//     recycling it — see countReferralRewards.
//   * Self-referral is judged by MAILBOX, not by address, so the `+tag` variant
//     of the same inbox is refused outright (server/utils/users.ts ›
//     isSameMailbox).
//
// What remains, accurately: two genuinely distinct mailboxes, one real
// non-refunded purchase, for 30 days on one of them. That is $18 of revenue for
// $18 of product — break-even, bounded by REFERRAL_MAX_REWARDS, and indexed in
// the audit trail. Fine. Unbounded free access is what had to go.
//
// Step 4 gets the same treatment from the other side. A signup costs one fresh
// mailbox, so the welcome ref is keyed on the MAILBOX rather than the account
// id — otherwise deleting and re-registering the same address refills the trial
// forever (server/utils/paddle-refs.ts › referralWelcomeRef).
//
// ── Idempotency is structural, not a flag ────────────────────────────────────
// There is no ledger table and no "already paid?" column, because both would
// need a read-then-write that a webhook redelivery can race. Instead each grant
// derives a DETERMINISTIC ref (server/utils/paddle-refs.ts) from the account it
// concerns, and the unique index on `entitlements.paddle_subscription_id`
// refuses the second one. Five redeliveries compute one ref and write one row.

import { and, count, eq, inArray, isNull } from 'drizzle-orm'

import {
  REFERRAL_CODE_MINT_ATTEMPTS,
  REFERRAL_MAX_REWARDS,
  REFERRAL_REWARD_DAYS,
  REFERRAL_WELCOME_DAYS,
} from '#shared/utils/referral'
import * as tables from '../db/schema'
import type { User } from '../db/schema'
import { writeAudit } from './audit'
import { ACTIVE_STATUSES, getBillingOverview, toSeconds } from './entitlements'
import type { EntitlementDb } from './entitlements'
import { saltedHash } from './hash'
import {
  REFERRAL_REF_PREFIX,
  isReferralRef,
  referralRewardRef,
  referralWelcomeRef,
} from './paddle-refs'
import { likePrefix } from './sql'
import {
  canonicalizeEmailForLimiting,
  findReferrerByCode,
  findUserById,
  generateReferralCode,
  isReferralCodeCollision,
  isSameMailbox,
} from './users'

const DAY_MS = 24 * 60 * 60 * 1000

/** The sentinel actor on an audit row nobody clicked. See server/utils/audit.ts. */
const SYSTEM_ACTOR = 'system'

/**
 * Status written when a referral grant is taken back.
 *
 * Deliberately the same string as admin-grants.ts's COMP_REVOKED_STATUS, and
 * deliberately a second declaration rather than an import: the two modules
 * describe unrelated events (an admin withdrew an apology; a refund clawed back
 * an earned reward) and should not be coupled, but the VALUE has to match,
 * because /account's billing history renders one `revoked` badge for both and a
 * second spelling would render a bare status word nobody has seen before.
 * test/referral.test.ts asserts they are equal, which is this repo's idiom for
 * two copies that must agree.
 *
 * Nothing has to learn this string to respect it: access is decided by the
 * ACTIVE_STATUSES allowlist, so any status outside it stops granting by
 * construction — findActiveEntitlement, deriveBillingState, requireSubscription
 * and the MCP worker's raw SQL all fall in line for free.
 */
export const REFERRAL_REVOKED_STATUS = 'revoked'

// ─── Granting ────────────────────────────────────────────────────────────────

/** Which side of the loop a grant is for. Ends up in the audit metadata. */
export type ReferralSide = 'referee' | 'referrer'

export type ReferralGrantOutcome =
  /** Days written. */
  | 'granted'
  /** This exact ref already exists — a redelivery, or a second purchase. */
  | 'already_granted'

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
 * ── A live subscriber IS paid, unlike a comp ─────────────────────────────────
 * This used to refuse whenever a subscription was already granting access,
 * copied from grantCompPasses(). It was the wrong rule in the wrong place, and
 * the reason is that a comp and an earned reward differ in who is owed what.
 *
 * A comp is an apology an operator chooses to send, so refusing it and naming a
 * better instrument (a Paddle credit) is good support. A referral reward has
 * already been EARNED, by somebody who read "you get 30 days when they pay" on
 * their own account page and then went and did it. Refusing costs them the
 * reward permanently — the trigger is a one-time transaction, so nothing ever
 * retries — and it fails precisely the referrers most worth having, since the
 * people who recommend a product are overwhelmingly the ones already paying for
 * it. Silently not paying your best customers is not a fraud control.
 *
 * So the days are written, stacked from the running expiry, which for a
 * subscriber is their renewal date: the reward begins when the subscription
 * ends. That is honest and it is what the share card now says. The old worry —
 * that the granted row outranks the subscription in findActiveEntitlement's
 * `ORDER BY current_period_end DESC` and makes /account misdescribe the plan —
 * was fixed independently in entitlement-view.ts, which pins the description to
 * a live `sub_` row whatever the dates say.
 *
 * The stacking base is `overview.active`, the longest-running granting row,
 * rather than the subscription specifically: if a pass runs past the renewal,
 * stacking on the renewal would throw away days the customer already holds.
 * A `sub_` row with no `current_period_end` (Paddle always sends one; a null
 * would mean a malformed event) has nothing to anchor on and starts today.
 */
async function planReferralGrant(
  db: EntitlementDb,
  params: { userId: string; ref: string; days: number; productKey?: string; now?: Date },
): Promise<ReferralGrantPlan> {
  const productKey = params.productKey ?? 'default'
  const now = params.now ?? new Date()

  const overview = await getBillingOverview(db, params.userId, productKey)

  const running = overview.active?.currentPeriodEnd
  const stackedOn = running && running > now ? running : null
  const base = stackedOn ?? now

  return {
    ref: params.ref,
    days: params.days,
    endsAt: toSeconds(new Date(base.getTime() + params.days * DAY_MS)),
    stackedOn,
    productKey,
    userId: params.userId,
  }
}

/**
 * Write one planned grant. Idempotent on the ref, by the unique index.
 *
 * ── Why DO NOTHING rather than grantPass's DO UPDATE ─────────────────────────
 * grantPass() infers "did this insert land?" by comparing the date it computed
 * against the date that came back from an upsert: on a redelivery the stored
 * value is whatever the first delivery wrote and the recomputed one has stacked
 * on top of it, so they differ. That inference is sound for a purchased pass
 * and NOT sound here, and the difference is the welcome grant.
 *
 * A welcome grant lands on an account with no entitlements, so its date is
 * always `now + 7 days` — recomputed identically on every attempt. Two attempts
 * inside the same second therefore produce the same truncated timestamp, the
 * comparison says "matches", and a conflict that wrote nothing is reported as a
 * fresh grant. The row stays correct (the index still refuses the duplicate),
 * but the RETURN VALUE lies, and it lies in the direction of "we just gave this
 * person a trial" — which is what the delete-and-re-register test caught.
 *
 * `DO NOTHING … RETURNING` has no inference in it: SQLite returns a row when it
 * inserted one and no rows when it skipped, so `granted` is the database's own
 * answer. The only thing given up is the `updated_at` bump on a redelivery,
 * which recorded nothing anybody reads.
 */
async function writeReferralGrant(
  db: EntitlementDb,
  plan: ReferralGrantPlan,
): Promise<{ granted: boolean; endsAt: Date }> {
  const inserted = await db
    .insert(tables.entitlements)
    .values({
      userId: plan.userId,
      paddleSubscriptionId: plan.ref,
      productKey: plan.productKey,
      status: 'active',
      currentPeriodEnd: plan.endsAt,
    })
    .onConflictDoNothing({ target: tables.entitlements.paddleSubscriptionId })
    .returning({ currentPeriodEnd: tables.entitlements.currentPeriodEnd })

  const row = inserted[0]
  if (row?.currentPeriodEnd) return { granted: true, endsAt: row.currentPeriodEnd }

  // Skipped: this ref already exists. Report the window that is actually in
  // force rather than the one this call would have written, so a caller never
  // tells somebody about days they do not have.
  const existing = await db.query.entitlements.findFirst({
    where: eq(tables.entitlements.paddleSubscriptionId, plan.ref),
    columns: { currentPeriodEnd: true },
  })
  return { granted: false, endsAt: existing?.currentPeriodEnd ?? plan.endsAt }
}

/**
 * Has this exact grant already been made?
 *
 * A point lookup on the unique index, and its only job is to keep the audit row
 * honest: audit-before-act means a payout that the index was always going to
 * refuse would otherwise leave a `referral.rewarded` row behind a grant that
 * never happened. The index is still the real guard — this read can be raced,
 * and losing that race costs one spurious audit row and no extra days.
 */
async function referralGrantExists(db: EntitlementDb, ref: string): Promise<boolean> {
  const row = await db.query.entitlements.findFirst({
    where: eq(tables.entitlements.paddleSubscriptionId, ref),
    columns: { id: true },
  })
  return Boolean(row)
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
  /** Referrer and referee are the same account, or the same mailbox. */
  | 'self_referral'
  /** This referrer has earned REFERRAL_MAX_REWARDS already. */
  | 'capped'
  /**
   * No session password, so no salt for the welcome ref. Refused rather than
   * degraded — see grantRefereeWelcome for why an unsalted ref is not an option.
   */
  | 'unconfigured'
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
 * The salt-derived, mailbox-scoped welcome ref for an address.
 *
 * Exported so test/referral.test.ts can assert the once-per-mailbox property
 * directly rather than inferring it from a row count, and so a support script
 * can answer "has this address already had its trial?" without guessing.
 */
export async function welcomeRefForEmail(email: string, salt: string): Promise<string | null> {
  if (!salt) return null
  const hash = await saltedHash(canonicalizeEmailForLimiting(email), salt)
  return hash ? referralWelcomeRef(hash) : null
}

/**
 * The referee's arrival bonus — REFERRAL_WELCOME_DAYS, once per MAILBOX.
 *
 * Called from establishSession() inside afterSignIn(), so it runs after the
 * session cookie is sealed and cannot fail a sign-in. It never throws anyway;
 * both guards exist because the cost of getting this wrong is that somebody's
 * account creation 500s over a free trial they did not ask for.
 *
 * ── Once per mailbox, not once per account ───────────────────────────────────
 * The ref is keyed on a salted hash of the canonical mailbox rather than on
 * `user.id`, because a user id is renewable and an inbox is not: deleting an
 * account frees its address, and signing up again mints a fresh id — so an
 * id-keyed ref hands out the trial again, and again, forever. Two mailboxes
 * taking turns would be permanent free access. See referralWelcomeRef().
 *
 * ── Why a missing salt refuses rather than degrades ──────────────────────────
 * Falling back to an unsalted digest would work, and would put a plain
 * SHA-256 of somebody's email address into a table that is rendered in the
 * admin console and included in "download your data" — reversible against any
 * mailing list. Falling back to the user id would silently reopen the hole this
 * function exists to close. Neither is worth a free trial, and `sessionPassword`
 * is mandatory for sessions to work at all, so nothing that can reach this line
 * in a working deployment will ever hit it.
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
  options: { salt: string; productKey?: string; now?: Date },
): Promise<ReferralResult> {
  try {
    if (!user.referredBy) return { outcome: 'no_referrer' }

    const ref = await welcomeRefForEmail(user.email, options.salt)
    if (!ref) {
      logReferral('referral_welcome_skipped', { reason: 'unconfigured', userId: user.id })
      return { outcome: 'unconfigured' }
    }

    // No `selfEmail` here, deliberately. That argument makes findReferrerByCode
    // fold "it's you" into "no such referrer", which is the right answer at
    // provisioning (there is no id yet to compare) and the wrong one here: the
    // two outcomes want different log lines, and "unresolved" sent somebody
    // looking for a deleted account that was never involved. The checks below
    // are the real gate.
    // Before anything else that would be recorded: this mailbox may already
    // have spent its trial on an account that has since been deleted, and the
    // audit row must not claim otherwise.
    if (await referralGrantExists(db, ref)) return { outcome: 'already_granted' }

    const referrer = await findReferrerByCode(db, user.referredBy)
    if (!referrer) {
      logReferral('referral_welcome_skipped', { reason: 'referrer_unresolved', userId: user.id })
      return { outcome: 'referrer_unresolved' }
    }
    // Two accounts, one inbox — `me+1@` on `me@`'s code. Provisioning refuses
    // this before `referred_by` is ever written, so reaching it means a row
    // predating that fix or a hand-edited column. Cheap to re-assert at the
    // moment access is handed out, which is the only moment that matters.
    if (referrer.id === user.id || isSameMailbox(referrer.email, user.email)) {
      logReferral('referral_welcome_skipped', { reason: 'self_referral', userId: user.id })
      return { outcome: 'self_referral' }
    }

    const plan = await planReferralGrant(db, {
      userId: user.id,
      ref,
      days: REFERRAL_WELCOME_DAYS,
      productKey: options.productKey,
      now: options.now,
    })

    return await payReferral(db, plan, {
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
 *
 * What "paid" can and cannot mean here is the caller's problem and is written
 * out at the call site (server/routes/paddle/webhook.post.ts). The backstop for
 * everything a status transition cannot distinguish — a refunded pass, a
 * charged-back invoice — is revokeReferralRewardForReferee() below.
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
    // Id first, then mailbox: `me+1@gmail.com` buying a pass on `me@gmail.com`'s
    // code is two accounts, one inbox, and one person paying themselves 30 days
    // for the price of a refundable purchase. Provisioning refuses it now, so
    // this catches rows written before that fix and anything hand-edited.
    if (referrer.id === refereeId || isSameMailbox(referrer.email, referee.email)) {
      logReferral('referral_reward_skipped', { reason: 'self_referral', refereeId })
      return { outcome: 'self_referral' }
    }

    const ref = referralRewardRef(refereeId)

    if (await referralGrantExists(db, ref)) {
      return { outcome: 'already_granted', referrerId: referrer.id }
    }

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

    // Paid whether or not they are already subscribed — the days stack from
    // their renewal date and begin when the subscription ends. See
    // planReferralGrant for why this is the opposite call from a comp's.
    const plan = await planReferralGrant(db, {
      userId: referrer.id,
      ref,
      days: REFERRAL_REWARD_DAYS,
      productKey: options.productKey,
      now: options.now,
    })

    return await payReferral(db, plan, {
      side: 'referrer',
      refereeId,
      referrerId: referrer.id,
    })
  } catch (error) {
    logReferral('referral_reward_failed', { refereeId, error: String(error) })
    return { outcome: 'error' }
  }
}

// ─── Taking it back ──────────────────────────────────────────────────────────

export type ReferralRevokeOutcome =
  /** The row was granting access and no longer is. */
  | 'revoked'
  /** No reward exists for this referee. The common answer, and not a problem. */
  | 'not_found'
  /** Already ended — revoked earlier, or a second adjustment for one purchase. */
  | 'already_revoked'
  /** Its 30 days were fully consumed before the money went back. See below. */
  | 'already_expired'
  /** Something threw. Logged, swallowed; Paddle redelivers adjustments. */
  | 'error'

export interface ReferralRevokeResult {
  outcome: ReferralRevokeOutcome
  ref: string
  /** The account the days were taken from, when any were. */
  referrerId?: string
}

/**
 * Claw back the reward paid for a referee whose purchase went backwards.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 * revokeForAdjustment() matches an adjustment to an entitlement by Paddle's own
 * transaction and subscription ids. The referrer's reward carries neither — its
 * ref is `referral_<refereeId>`, which Paddle has never heard of — so no refund
 * or chargeback could reach it, and the days survived the money going back.
 *
 * That made the loop's cost story false. A referee could buy the $18 pass,
 * hand the referrer 30 days, and refund the same day; through `+1`, `+2`, `+3`
 * sub-addresses of one inbox that is unlimited free access for a few refund
 * requests. (The sub-address half is refused separately now, by mailbox — see
 * isSameMailbox — but the refund half had to close on its own, because two
 * genuinely different people can run the same trick with two real inboxes.)
 *
 * ── Only ever a referral row ─────────────────────────────────────────────────
 * The ref is constructed here, so it cannot be anything else — and it is
 * asserted anyway, the way grantCompPasses() asserts its prefix. A `sub_` or
 * `txn_` row is money Paddle owns: writing a local status onto one is either
 * overwritten by the next webhook or takes away access somebody paid for.
 * Paddle's own revocation path (revokeForAdjustment) handles those, and this
 * runs beside it, never over it.
 *
 * ── An expired reward is left completely alone ───────────────────────────────
 * Same rule as revokeCompPass(), and it matters more here. Nothing flips a
 * referral row's status when its window closes, so a reward from eight months
 * ago still reads `status: 'active'` with a date in the past. Setting
 * `current_period_end = now` on that would drag a past date FORWARD, rewriting
 * history to say the referrer had access for longer than they did.
 *
 * It also gives the policy a sensible edge for free: a chargeback on month
 * seven of a subscription finds a reward whose 30 days were consumed long ago
 * and writes nothing, so a referrer is not punished for how their referee's
 * relationship ended half a year later. Only a clawback that arrives while the
 * days are still running takes anything away — which is exactly the refund-
 * churn case, and not the honest-referral one.
 */
export async function revokeReferralRewardForReferee(
  db: EntitlementDb,
  refereeId: string,
  options: { now?: Date } = {},
): Promise<ReferralRevokeResult> {
  const ref = referralRewardRef(refereeId)
  try {
    const now = options.now ?? new Date()

    // Cheap assertion, catastrophic omission — see the note above.
    if (!isReferralRef(ref)) return { outcome: 'not_found', ref }

    const row = await db.query.entitlements.findFirst({
      where: eq(tables.entitlements.paddleSubscriptionId, ref),
    })
    if (!row) return { outcome: 'not_found', ref }

    // Status before window, so a second adjustment reports the more useful of
    // two true things ("somebody already took this back", not "it expired").
    if (!ACTIVE_STATUSES.includes(row.status)) {
      return { outcome: 'already_revoked', ref, referrerId: row.userId }
    }
    if (row.currentPeriodEnd && row.currentPeriodEnd <= now) {
      return { outcome: 'already_expired', ref, referrerId: row.userId }
    }

    await writeAudit(db, {
      actorUserId: SYSTEM_ACTOR,
      actorType: 'system',
      action: 'referral.revoked',
      targetType: 'user',
      targetId: row.userId,
      metadata: { ref, refereeId, referrerId: row.userId, reason: 'referee_purchase_reversed' },
    })

    const revoked = await db
      .update(tables.entitlements)
      .set({
        status: REFERRAL_REVOKED_STATUS,
        // BOTH, exactly as revokeForAdjustment and revokeCompPass do. The
        // status is what the app's allowlist reads and the date is what
        // anything checking only the window reads (the MCP worker's raw SQL);
        // the two must never disagree about whether somebody has access.
        currentPeriodEnd: now,
        updatedAt: new Date(),
      })
      // Guards repeated in the WHERE rather than trusted from the read above:
      // two adjustment deliveries in flight both pass the read, only one
      // matches here, and the loser writes nothing instead of stamping a
      // second, later expiry over the first.
      .where(
        and(
          eq(tables.entitlements.paddleSubscriptionId, ref),
          inArray(tables.entitlements.status, ACTIVE_STATUSES),
        ),
      )
      .returning({ id: tables.entitlements.id })

    if (!revoked.length) return { outcome: 'already_revoked', ref, referrerId: row.userId }

    logReferral('referral_reward_revoked', { refereeId, referrerId: row.userId, ref })
    return { outcome: 'revoked', ref, referrerId: row.userId }
  } catch (error) {
    logReferral('referral_revoke_failed', { refereeId, error: String(error) })
    return { outcome: 'error', ref }
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
 * ── Revoked rows still count, and that is the anti-churn property ───────────
 * The cap bounds how many payouts an account can TRIGGER, not how many are
 * currently granting access. Counting only live rows would mean a refund both
 * clawed the days back and refunded the budget slot, so an attacker could cycle
 * buy → collect → refund indefinitely and never approach the ceiling. Spent is
 * spent: a reward that was granted and taken away has still used one of the ten.
 *
 * ── The count is read-then-write, and the bound is soft by a fan-out ─────────
 * Two referees' first purchases delivered concurrently at nine both read nine
 * and both write, so the true ceiling is REFERRAL_MAX_REWARDS plus however many
 * webhook deliveries are in flight at once — a handful, not unbounded. Accepted
 * rather than fixed: closing it needs a transaction or a counter column, and
 * the cap is a blast radius rather than an accounting figure. The audit trail
 * is what an investigation reads, and it records every payout regardless.
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
