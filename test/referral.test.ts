// The referral loop, against a real D1 inside workerd.
//
// This is money logic, so the tests are the fraud cases rather than the happy
// path. Each one below is a way somebody gets paid for nothing, and each one
// fails silently in production if it regresses — an over-payment produces no
// error, no log line anybody reads, and no symptom until a revenue chart bends.
//
//   1. A webhook redelivery must not pay twice. Paddle redelivers, routinely.
//   2. A referrer must not exceed the cap, ever, whatever the referees do.
//   3. Self-referral must pay nothing.
//   4. A deleted (tombstoned) referrer must pay nothing.
//   5. A live subscriber must not be handed days that stack past their renewal
//      and therefore deliver zero — the same refusal grantCompPasses makes.
//   6. A code that resolves to nobody must never become `users.referred_by`,
//      because the welcome grant is keyed on that column being trustworthy.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  attributionFromRecord,
  consumeMagicLinkToken,
  createMagicLinkToken,
} from '../server/utils/magic-link'
import {
  REFERRAL_MAX_REWARDS,
  REFERRAL_REWARD_DAYS,
  REFERRAL_WELCOME_DAYS,
  normalizeReferralCode,
  referralShareUrl,
} from '../shared/utils/referral'
import {
  countReferralRewards,
  countStandingReferralRewards,
  ensureReferralCode,
  getReferralSummary,
  grantRefereeWelcome,
  recordReferralCascade,
  rewardReferrerForFirstPurchase,
  welcomeRefForEmail,
} from '../server/utils/referral'
import { COMP_REVOKED_STATUS } from '../server/utils/admin-grants'
import { deleteAccount } from '../server/utils/account'
import {
  DERIVED_REVOKED_STATUS,
  PASS_DAYS,
  findActiveEntitlement,
  grantPass,
  revokeForAdjustment,
} from '../server/utils/entitlements'
import { buildEntitlementView } from '../server/utils/entitlement-view'
import { isReferralRef, referralRewardRef, referralWelcomeRef } from '../server/utils/paddle-refs'
import { generateReferralCode, upsertOAuthUser } from '../server/utils/users'
import { getIdentitySalt } from '../server/utils/identity'
import { saltedHash } from '../server/utils/hash'
import { legacyWelcomeRefForEmail } from '../server/utils/referral'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const REFERRER_CODE = 'AB2CD3EF'

/**
 * The welcome ref is a salted hash of the mailbox, and the salt is provisioned
 * in D1 rather than configured — so tests read the real one the same way
 * production does. `LEGACY_SALT` stands in for the sessionPassword the previous
 * construction used, which grantRefereeWelcome still checks during transition.
 */
const LEGACY_SALT = 'test-session-password'
let SALT = ''

/** The referee as grantRefereeWelcome takes it: id, address, and the claim. */
const REFEREE = {
  id: 'referee',
  email: 'referee@example.com',
  referredBy: REFERRER_CODE,
} as const

/** D1 timestamp columns are epoch seconds — expectations round the same way. */
function atSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

/**
 * Driven at wall-clock now rather than a fixed date: findActiveEntitlement
 * compares `current_period_end` against the real clock and takes no injection,
 * so a literal date makes the suite pass in March and fail in September.
 */
const NOW = new Date(atSecond(Date.now()))

async function makeUser(
  id: string,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<void> {
  await db
    .insert(schema.users)
    .values({ id, email: `${id}@example.com`, name: id, ...overrides })
    .onConflictDoNothing()
}

beforeEach(async () => {
  // Provisioned once per file, then stable — the whole point of the column.
  SALT ||= await getIdentitySalt(db)
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
})

// ── The numbers ─────────────────────────────────────────────────────────────

describe('the reward amounts', () => {
  it('pays the referrer exactly one pass', () => {
    // Two constants for one quantity, in two modules that cannot import each
    // other's layer (a Vue component reads the shared one, the grant path reads
    // PASS_DAYS). This is the gate that stops them drifting.
    expect(REFERRAL_REWARD_DAYS).toBe(PASS_DAYS)
  })

  it('pays the referee less than a pass, because a signup costs an attacker nothing', () => {
    // The load-bearing inequality of the whole feature. At parity, N throwaway
    // mailboxes are N free months and the paid product is optional.
    expect(REFERRAL_WELCOME_DAYS).toBeLessThan(PASS_DAYS)
    expect(REFERRAL_WELCOME_DAYS).toBeGreaterThan(0)
  })
})

describe('the code shape', () => {
  it('accepts exactly what the generator produces, and nothing adjacent', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode()
      expect(normalizeReferralCode(code)).toBe(code)
    }
  })

  it('builds a share link on the home page, and nothing at all without an origin', () => {
    expect(referralShareUrl('https://example.com/', REFERRER_CODE)).toBe(
      `https://example.com/?ref=${REFERRER_CODE}`,
    )
    expect(referralShareUrl(undefined, REFERRER_CODE)).toBe('')
    expect(referralShareUrl('https://example.com', 'junk')).toBe('')
  })

  it('marks both grant refs as referral access', () => {
    expect(isReferralRef(referralRewardRef('someone'))).toBe(true)
    expect(isReferralRef(referralWelcomeRef('someone'))).toBe(true)
    expect(isReferralRef('txn_paid')).toBe(false)
    expect(isReferralRef('comp_given')).toBe(false)
  })
})

// ── Resolution at signup ────────────────────────────────────────────────────

describe('resolving a referral code at account creation', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
  })

  it('freezes the referrer onto the new account', async () => {
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'referee@example.com' },
      { source: 'referral', medium: 'invite', referralCode: REFERRER_CODE },
    )
    expect(user.referredBy).toBe(REFERRER_CODE)
  })

  it('drops a code nobody holds rather than storing a dangling claim', async () => {
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'referee@example.com' },
      { source: 'referral', medium: 'invite', referralCode: 'ZZ9YY8XX' },
    )
    expect(user.referredBy).toBeNull()
  })

  it('refuses a tombstoned referrer', async () => {
    // Deletion nulls the code, but a later account could mint the freed one —
    // so the address is checked too. A deleted account can never earn.
    await makeUser('gone', {
      email: 'deleted-gone@deleted.invalid',
      referralCode: 'QQ4RR5SS',
    })
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'referee@example.com' },
      { referralCode: 'QQ4RR5SS' },
    )
    expect(user.referredBy).toBeNull()
  })

  it('never rewrites it on a later sign-in', async () => {
    // First-touch, exactly like the four marketing columns beside it: somebody
    // who returns through a different friend's link stays credited to the first.
    await upsertOAuthUser(
      db,
      { provider: 'email', email: 'referee@example.com' },
      {
        referralCode: REFERRER_CODE,
      },
    )
    await makeUser('second', { referralCode: 'MM6NN7PP' })

    const { user, created } = await upsertOAuthUser(
      db,
      { provider: 'google', email: 'referee@example.com' },
      { referralCode: 'MM6NN7PP' },
    )
    expect(created).toBe(false)
    expect(user.referredBy).toBe(REFERRER_CODE)
  })
})

// ── Cross-device magic-link redemption ──────────────────────────────────────
// The path this loop is most likely to lose credit on, and the reason
// `magic_link_tokens.referral_code` exists. Requested on a laptop that has the
// `attr` cookie, opened on a phone that has never had one — which for email
// sign-in is the common case, not the edge one.
//
// Driven through the real functions in the real order (mint → consume →
// rebuild → provision) rather than through establishSession, which needs an H3
// event. The one thing that stands in for "a fresh device" is that NOTHING here
// consults a cookie: everything the new account learns has to come off the row.

describe('a magic link opened on another device', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM magic_link_tokens')
    await makeUser('referrer', { referralCode: REFERRER_CODE })
  })

  it('still credits the referrer', async () => {
    // Laptop: the visitor landed on /?ref=…, so the cookie the mint endpoint
    // reads carries the code alongside the channel.
    const { token } = await createMagicLinkToken(db, {
      email: 'referee@example.com',
      attribution: { source: 'referral', medium: 'invite', referralCode: REFERRER_CODE },
    })

    // Phone: a different browser. The token is all it has.
    const consumed = await consumeMagicLinkToken(db, token)
    expect(consumed.ok).toBe(true)
    if (!consumed.ok) return

    const carried = attributionFromRecord(consumed.record)
    expect(carried?.referralCode).toBe(REFERRER_CODE)

    const { user, created } = await upsertOAuthUser(
      db,
      { provider: 'email', email: consumed.record.email },
      carried,
    )

    expect(created).toBe(true)
    expect(user.referredBy).toBe(REFERRER_CODE)
    // …and the channel columns still arrive with it, unchanged.
    expect(user.signupSource).toBe('referral')
    expect(user.signupMedium).toBe('invite')

    // The welcome grant follows from that column alone, so the referee gets
    // their days on a device that never saw the link they arrived through.
    const welcome = await grantRefereeWelcome(db, user, { sessionPassword: LEGACY_SALT })
    expect(welcome.outcome).toBe('granted')
    expect(welcome.days).toBe(REFERRAL_WELCOME_DAYS)
  })

  it('carries nothing when the link was never a referral', async () => {
    const { token } = await createMagicLinkToken(db, {
      email: 'organic@example.com',
      attribution: { source: 'google.com', medium: 'organic' },
    })
    const consumed = await consumeMagicLinkToken(db, token)
    if (!consumed.ok) throw new Error('token should have been consumable')

    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'organic@example.com' },
      attributionFromRecord(consumed.record),
    )
    expect(user.referredBy).toBeNull()
  })

  it('drops a code the row carries that no live account holds', async () => {
    // The row is a copy of a cookie, so it is exactly as untrusted as one. The
    // resolution happens at redemption, not at mint.
    const { token } = await createMagicLinkToken(db, {
      email: 'referee@example.com',
      attribution: { source: 'referral', medium: 'invite', referralCode: 'ZZ9YY8XX' },
    })
    const consumed = await consumeMagicLinkToken(db, token)
    if (!consumed.ok) throw new Error('token should have been consumable')

    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'referee@example.com' },
      attributionFromRecord(consumed.record),
    )
    expect(user.referredBy).toBeNull()
  })

  it('adopts NOTHING from the redeeming machine when the row carries no attribution', async () => {
    // The kiosk case. A token minted with no attribution used to let
    // establishSession fall back to the `attr` cookie on the REDEEMING browser
    // — which on a shared machine is a stranger's, complete with their `?ref=`.
    // verify.post.ts now passes `?? null`, which asserts "there is none".
    const { token } = await createMagicLinkToken(db, { email: 'kiosk@example.com' })
    const consumed = await consumeMagicLinkToken(db, token)
    if (!consumed.ok) throw new Error('token should have been consumable')

    expect(attributionFromRecord(consumed.record)).toBeUndefined()

    // What verify.post.ts hands establishSession, and what it must mean.
    const carried = attributionFromRecord(consumed.record) ?? null
    expect(carried).toBeNull()

    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'kiosk@example.com' },
      carried,
    )
    expect(user.referredBy).toBeNull()
    expect(user.signupSource).toBeNull()
  })
})

// ── The referee's welcome grant ─────────────────────────────────────────────

describe('grantRefereeWelcome', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  it('grants the welcome days to the referee, not the referrer', async () => {
    const result = await grantRefereeWelcome(db, REFEREE, { sessionPassword: LEGACY_SALT })

    expect(result.outcome).toBe('granted')
    expect(result.days).toBe(REFERRAL_WELCOME_DAYS)

    const granting = await findActiveEntitlement(db, 'referee')
    expect(granting?.paddleSubscriptionId).toBe(
      await welcomeRefForEmail('referee@example.com', SALT),
    )
    // The referrer is paid on the referee's first PURCHASE and not before.
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()
  })

  it('grants once per account, however many times it is called', async () => {
    const first = await grantRefereeWelcome(db, REFEREE, { sessionPassword: LEGACY_SALT })
    const second = await grantRefereeWelcome(db, REFEREE, { sessionPassword: LEGACY_SALT })

    expect(first.outcome).toBe('granted')
    expect(second.outcome).toBe('already_granted')

    const rows = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, 'referee'))
    expect(rows).toHaveLength(1)
  })

  it('does nothing for an account nobody referred', async () => {
    await makeUser('organic')
    const result = await grantRefereeWelcome(
      db,
      { id: 'organic', email: 'organic@example.com', referredBy: null },
      { sessionPassword: LEGACY_SALT },
    )
    expect(result.outcome).toBe('no_referrer')
    expect(await findActiveEntitlement(db, 'organic')).toBeNull()
  })

  it('refuses a code that no live account holds', async () => {
    await makeUser('orphan', { referredBy: 'ZZ9YY8XX' })
    const result = await grantRefereeWelcome(
      db,
      { id: 'orphan', email: 'orphan@example.com', referredBy: 'ZZ9YY8XX' },
      { sessionPassword: LEGACY_SALT },
    )
    expect(result.outcome).toBe('referrer_unresolved')
    expect(await findActiveEntitlement(db, 'orphan')).toBeNull()
  })

  it('refuses an account that names its own code', async () => {
    await makeUser('narcissus', { referralCode: 'TT2VV3WW', referredBy: 'TT2VV3WW' })
    const result = await grantRefereeWelcome(
      db,
      { id: 'narcissus', email: 'narcissus@example.com', referredBy: 'TT2VV3WW' },
      { sessionPassword: LEGACY_SALT },
    )
    expect(result.outcome).toBe('self_referral')
    expect(await findActiveEntitlement(db, 'narcissus')).toBeNull()
  })
})

// ── The referrer's reward ───────────────────────────────────────────────────

describe('rewardReferrerForFirstPurchase', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  it('pays the referrer a whole pass, and writes an audit row for it', async () => {
    const result = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })

    expect(result.outcome).toBe('granted')
    expect(result.referrerId).toBe('referrer')
    expect(result.days).toBe(REFERRAL_REWARD_DAYS)
    expect(result.endsAt?.getTime()).toBe(atSecond(NOW.getTime() + PASS_DAYS * DAY_MS))

    const granting = await findActiveEntitlement(db, 'referrer')
    expect(granting?.paddleSubscriptionId).toBe(referralRewardRef('referee'))

    const [audit] = await db.select().from(schema.auditLog)
    expect(audit?.action).toBe('referral.rewarded')
    expect(audit?.actorType).toBe('system')
    expect(audit?.targetId).toBe('referrer')
    expect(audit?.metadata).toMatchObject({
      side: 'referrer',
      days: REFERRAL_REWARD_DAYS,
      refereeId: 'referee',
    })
    // Ids and numbers only. An audit row outlives the account it describes, and
    // a referral code is a shareable credential rather than a durable fact.
    expect(JSON.stringify(audit?.metadata)).not.toContain(REFERRER_CODE)
    expect(JSON.stringify(audit?.metadata)).not.toContain('@example.com')
  })

  it('pays once across a webhook redelivery', async () => {
    // The property the whole design turns on. Paddle redelivers; there is no
    // ledger table and no flag — the ref is derived from the referee's id and
    // the unique index refuses the second write.
    const first = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    const second = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    const third = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })

    expect(first.outcome).toBe('granted')
    expect(second.outcome).toBe('already_granted')
    expect(third.outcome).toBe('already_granted')

    const rows = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, 'referrer'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.currentPeriodEnd?.getTime()).toBe(atSecond(NOW.getTime() + PASS_DAYS * DAY_MS))

    // …and a refused payout leaves no audit row claiming one happened.
    expect(await db.select().from(schema.auditLog)).toHaveLength(1)
  })

  it('stacks a second referee onto the days already earned', async () => {
    await makeUser('referee-2', { referredBy: REFERRER_CODE })

    const first = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    const second = await rewardReferrerForFirstPurchase(db, 'referee-2', { now: NOW })

    expect(second.outcome).toBe('granted')
    // Laid end to end, never reset — nobody loses days they already earned.
    expect(second.stackedOn?.getTime()).toBe(first.endsAt?.getTime())
    expect(second.endsAt?.getTime()).toBe(atSecond(NOW.getTime() + 2 * PASS_DAYS * DAY_MS))
    expect(await countReferralRewards(db, 'referrer')).toBe(2)
  })

  it('stops at the cap, and says why', async () => {
    // The cap is a blast radius, not a business rule: an account past it is
    // either an affiliate or a ring, and both need a human rather than another
    // increment.
    for (let i = 0; i < REFERRAL_MAX_REWARDS; i++) {
      await db.insert(schema.entitlements).values({
        userId: 'referrer',
        paddleSubscriptionId: referralRewardRef(`historic-${i}`),
        status: 'active',
        currentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
      })
    }

    const result = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect(result.outcome).toBe('capped')
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  it('does not let the referee’s own welcome grant eat the referrer’s budget', async () => {
    // The reason the two grants carry different prefixes. `welcome_` rows are a
    // person's own arrival; only `referral_` rows are referrals they earned.
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: (await welcomeRefForEmail('referrer@example.com', SALT))!,
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
    })
    expect(await countReferralRewards(db, 'referrer')).toBe(0)
  })

  it('counts a REVOKED reward against the cap, so refund-churn cannot recycle it', async () => {
    // The property that makes the clawback worth having. If the cap only
    // counted live rows, buy → collect → refund would return the budget slot
    // and the ceiling would be unreachable by construction.
    await grantPass(db, { userId: 'referee', transactionId: 'txn_churn', billedAt: NOW })
    await rewardReferrerForFirstPurchase(db, 'referee', {
      now: NOW,
      earnedFromRef: 'txn_churn',
    })
    await revokeForAdjustment(db, { action: 'chargeback', transactionId: 'txn_churn' })

    // Spent is spent…
    expect(await countReferralRewards(db, 'referrer')).toBe(1)
    // …but it is not days anybody has, so the share card must not claim it.
    expect(await countStandingReferralRewards(db, 'referrer')).toBe(0)
    expect((await getReferralSummary(db, 'referrer'))?.rewardedCount).toBe(0)
  })

  it('pays nothing for a self-referral', async () => {
    await makeUser('solo', { referralCode: 'TT2VV3WW', referredBy: 'TT2VV3WW' })
    const result = await rewardReferrerForFirstPurchase(db, 'solo', { now: NOW })
    expect(result.outcome).toBe('self_referral')
    expect(await findActiveEntitlement(db, 'solo')).toBeNull()
  })

  it('pays nothing to a tombstoned referrer', async () => {
    await makeUser('ghost', {
      email: 'deleted-ghost@deleted.invalid',
      referralCode: 'QQ4RR5SS',
    })
    await makeUser('their-referee', { referredBy: 'QQ4RR5SS' })

    const result = await rewardReferrerForFirstPurchase(db, 'their-referee', { now: NOW })
    expect(result.outcome).toBe('referrer_unresolved')
    expect(await findActiveEntitlement(db, 'ghost')).toBeNull()
  })

  it('PAYS a live subscriber, anchored past their renewal', async () => {
    // The opposite of what this used to assert, and the reason is that a comp
    // and an earned reward are different things. Refusing lost the reward
    // permanently — the trigger is one-time and never retries — and it did so
    // to exactly the referrers most worth having, since the people who
    // recommend a product are the ones already paying for it.
    const renewsAt = new Date(atSecond(NOW.getTime() + 20 * DAY_MS))
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: 'sub_live',
      status: 'active',
      currentPeriodEnd: renewsAt,
    })

    const result = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect(result.outcome).toBe('granted')
    // Stacked from the renewal, so the days begin when the subscription ends —
    // which is what the share card and the billing history now promise.
    expect(result.stackedOn?.getTime()).toBe(renewsAt.getTime())
    expect(result.endsAt?.getTime()).toBe(
      atSecond(renewsAt.getTime() + REFERRAL_REWARD_DAYS * DAY_MS),
    )

    const rows = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(rows).toHaveLength(1)
  })

  it('still describes that referrer as a subscriber, not as a pass holder', async () => {
    // The bug the old refusal was really guarding against: the reward row wins
    // findActiveEntitlement's `ORDER BY current_period_end DESC`, so /account
    // could have told a paying customer "You have a one-time pass" beside a
    // working cancel button. entitlement-view pins the description to the live
    // `sub_` row, which is what makes paying the subscriber safe.
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: 'sub_live',
      status: 'active',
      currentPeriodEnd: new Date(atSecond(NOW.getTime() + 20 * DAY_MS)),
    })
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })

    const view = await buildEntitlementView(db, 'referrer', { portalConfigured: false })
    expect(view.kind).toBe('subscription')
    expect(view.active).toBe(true)
    expect(view.cancellable).toBe(1)
    // …and the earned days are visible in history, labelled as what they are.
    expect(view.history.some((row) => row.referral)).toBe(true)
    // A live subscription still owns the top-level description, so nothing here
    // reads as referral days.
    expect(view.referralKind).toBeNull()
  })
})

// ── What /account says the access IS ────────────────────────────────────────
// A referral grant is a pass by SHAPE and not by story, and the summary used to
// tell somebody whose only access came from a friend's invite "You have a
// one-time pass. It will not renew." — describing a purchase they never made.

describe('buildEntitlementView on referral access', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  it('calls a welcome grant what it is', async () => {
    await grantRefereeWelcome(db, REFEREE, { sessionPassword: LEGACY_SALT })

    const view = await buildEntitlementView(db, 'referee', { portalConfigured: false })
    expect(view.active).toBe(true)
    expect(view.kind).toBe('pass')
    expect(view.referralKind).toBe('welcome')
    // Not a comp — different provenance, and only one of the two is revocable
    // from the admin console.
    expect(view.comped).toBe(false)
  })

  it('distinguishes an EARNED reward from a welcome grant', async () => {
    await grantPass(db, { userId: 'referee', transactionId: 'txn_paid', billedAt: NOW })
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW, earnedFromRef: 'txn_paid' })

    const view = await buildEntitlementView(db, 'referrer', { portalConfigured: false })
    expect(view.referralKind).toBe('reward')
  })

  it('says nothing about referrals for ordinary paid access', async () => {
    await grantPass(db, { userId: 'referee', transactionId: 'txn_paid', billedAt: NOW })
    const view = await buildEntitlementView(db, 'referee', { portalConfigured: false })
    expect(view.kind).toBe('pass')
    expect(view.referralKind).toBeNull()
  })

  it('does nothing at all for a customer nobody referred', async () => {
    await makeUser('organic')
    expect((await rewardReferrerForFirstPurchase(db, 'organic')).outcome).toBe('no_referrer')
  })

  it('never throws, whatever it is handed', async () => {
    // The contract with the Paddle webhook: a throw here becomes a non-200 and
    // Paddle replays a money event.
    await expect(rewardReferrerForFirstPurchase(db, 'nobody-at-all')).resolves.toMatchObject({
      outcome: 'no_referrer',
    })
  })
})

// ── Refund clawback, keyed on the PURCHASE ────────────────────────
// The cascade lives in revokeForAdjustment (server/utils/entitlements.ts) so
// every caller gets it, and it is keyed on `earned_from_ref` — the transaction
// that earned the reward — rather than on the person who made it. Keyed on the
// person it was wrong three ways at once: a refund of somebody's SECOND
// purchase clawed back the reward their first one earned, a $2 goodwill credit
// destroyed a reward the money had not reversed, and a chargeback the merchant
// WON left the referrer revoked forever.

describe('the refund cascade', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  /** Referee buys a pass and the referrer is paid for that exact transaction. */
  async function purchaseAndReward(txn: string): Promise<void> {
    await grantPass(db, { userId: 'referee', transactionId: txn, billedAt: NOW })
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW, earnedFromRef: txn })
  }

  it('records which purchase earned the reward', async () => {
    await purchaseAndReward('txn_first')
    const [row] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(row?.earnedFromRef).toBe('txn_first')
  })

  it('revokes the reward when that purchase is fully refunded', async () => {
    await purchaseAndReward('txn_first')
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()

    const result = await revokeForAdjustment(db, {
      action: 'refund',
      status: 'approved',
      type: 'full',
      transactionId: 'txn_first',
    })

    expect(result.outcome).toBe('revoked')
    expect(result.derived?.map((change) => change.ref)).toEqual([referralRewardRef('referee')])
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()

    const [row] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(row?.status).toBe(DERIVED_REVOKED_STATUS)
    // Kept so the reversal below can put the window back.
    expect(row?.restorePeriodEnd).not.toBeNull()
  })

  it('leaves the reward alone when a LATER purchase is refunded', async () => {
    // The reward was earned by the first pass. Refunding the second reverses
    // money that bought nothing for anybody but the referee.
    await purchaseAndReward('txn_first')
    await grantPass(db, { userId: 'referee', transactionId: 'txn_second', billedAt: NOW })

    const result = await revokeForAdjustment(db, {
      action: 'refund',
      status: 'approved',
      type: 'full',
      transactionId: 'txn_second',
    })

    expect(result.outcome).toBe('revoked')
    expect(result.derived).toEqual([])
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()
  })

  it('leaves the reward alone on a PARTIAL refund', async () => {
    // A goodwill credit is not a reversal of the sale. The referee's own access
    // still ends — that policy is deliberate and unchanged — but destroying a
    // reward somebody earned over a $2 gesture is not the same decision.
    await purchaseAndReward('txn_first')

    const result = await revokeForAdjustment(db, {
      action: 'refund',
      status: 'approved',
      type: 'partial',
      transactionId: 'txn_first',
    })

    expect(result.outcome).toBe('revoked')
    expect(result.derived).toEqual([])
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()
  })

  it('revokes on a chargeback, whatever its type says', async () => {
    await purchaseAndReward('txn_first')
    const result = await revokeForAdjustment(db, {
      action: 'chargeback',
      transactionId: 'txn_first',
    })
    expect(result.derived).toHaveLength(1)
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()
  })

  it('RESTORES the reward when the chargeback is reversed', async () => {
    // The merchant won the dispute. Nothing reached the old clawback on this
    // path — not a revoking action, not a final status — so the referrer stayed
    // punished for a chargeback that never stood.
    await purchaseAndReward('txn_first')
    const [before] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))

    await revokeForAdjustment(db, { action: 'chargeback', transactionId: 'txn_first' })
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()

    const reversal = await revokeForAdjustment(db, {
      action: 'chargeback',
      status: 'reversed',
      transactionId: 'txn_first',
    })

    expect(reversal.outcome).toBe('reversed')
    expect(reversal.derived).toHaveLength(1)

    const [after] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(after?.status).toBe('active')
    // The original window, not a fresh one starting today.
    expect(after?.currentPeriodEnd?.getTime()).toBe(before?.currentPeriodEnd?.getTime())
    // Cleared, so a redelivered reversal finds nothing to restore.
    expect(after?.restorePeriodEnd).toBeNull()
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()
  })

  it('handles the distinct chargeback_reverse action too', async () => {
    await purchaseAndReward('txn_first')
    await revokeForAdjustment(db, { action: 'chargeback', transactionId: 'txn_first' })

    const reversal = await revokeForAdjustment(db, {
      action: 'chargeback_reverse',
      transactionId: 'txn_first',
    })
    expect(reversal.outcome).toBe('reversed')
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()
  })

  it('is idempotent in both directions', async () => {
    await purchaseAndReward('txn_first')
    const refund = {
      action: 'refund',
      status: 'approved',
      type: 'full',
      transactionId: 'txn_first',
    }

    await revokeForAdjustment(db, refund)
    // A redelivered refund finds the row already non-granting and writes
    // nothing — which matters, because a second write would stamp the revoked
    // date into restore_period_end and make the row unrestorable.
    const again = await revokeForAdjustment(db, refund)
    expect(again.derived).toEqual([])

    await revokeForAdjustment(db, {
      action: 'chargeback',
      status: 'reversed',
      transactionId: 'txn_first',
    })
    const reversedAgain = await revokeForAdjustment(db, {
      action: 'chargeback',
      status: 'reversed',
      transactionId: 'txn_first',
    })
    expect(reversedAgain.derived).toEqual([])
  })

  it('leaves an already-expired reward alone', async () => {
    // Writing `current_period_end = now` on a window that closed months ago
    // would drag a past date FORWARD. It also gives the policy a sensible edge:
    // a chargeback on month seven does not punish the referrer for days long
    // since spent.
    await grantPass(db, { userId: 'referee', transactionId: 'txn_old', billedAt: NOW })
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: referralRewardRef('referee'),
      status: 'active',
      currentPeriodEnd: new Date(atSecond(NOW.getTime() - 200 * DAY_MS)),
      earnedFromRef: 'txn_old',
    })

    const result = await revokeForAdjustment(db, {
      action: 'chargeback',
      transactionId: 'txn_old',
    })
    expect(result.derived).toEqual([])

    const [row] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(row?.status).toBe('active')
    expect(row?.currentPeriodEnd?.getTime()).toBe(atSecond(NOW.getTime() - 200 * DAY_MS))
  })

  it('never touches a row of unknown provenance', async () => {
    // A reward granted before `earned_from_ref` existed carries NULL, and a
    // missed clawback is recoverable while clawing back a legitimately earned
    // reward is a conversation with an honest customer.
    await grantPass(db, { userId: 'referee', transactionId: 'txn_first', billedAt: NOW })
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: referralRewardRef('referee'),
      status: 'active',
      currentPeriodEnd: new Date(atSecond(NOW.getTime() + 30 * DAY_MS)),
    })

    const result = await revokeForAdjustment(db, {
      action: 'chargeback',
      transactionId: 'txn_first',
    })
    expect(result.derived).toEqual([])
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()
  })

  it('writes an audit row for each side of the cascade', async () => {
    await purchaseAndReward('txn_first')
    const revoked = await revokeForAdjustment(db, {
      action: 'chargeback',
      transactionId: 'txn_first',
    })
    await recordReferralCascade(db, revoked)

    const restored = await revokeForAdjustment(db, {
      action: 'chargeback',
      status: 'reversed',
      transactionId: 'txn_first',
    })
    await recordReferralCascade(db, restored)

    const actions = (await db.select().from(schema.auditLog)).map((row) => row.action)
    expect(actions).toContain('referral.revoked')
    expect(actions).toContain('referral.restored')
  })

  it('spells its revoked status the same way a comp does', () => {
    // /account renders one `revoked` badge for both; a second spelling would
    // surface a status word the UI has never seen.
    expect(DERIVED_REVOKED_STATUS).toBe(COMP_REVOKED_STATUS)
  })
})

// ── One inbox, two accounts ─────────────────────────────────────────────────
// Sub-addressing is the cheapest way to look like two people. `me+1@gmail.com`
// and `me@gmail.com` are one mailbox, and an exact-address comparison waves the
// pair straight through.

describe('self-referral by sub-address', () => {
  it('is refused at provisioning, so referred_by is never written', async () => {
    await makeUser('self', { email: 'me@gmail.com', referralCode: REFERRER_CODE })

    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'me+1@gmail.com' },
      { source: 'referral', medium: 'invite', referralCode: REFERRER_CODE },
    )
    expect(user.referredBy).toBeNull()
  })

  it('is refused at payout too, for rows written before that guard existed', async () => {
    await makeUser('self', { email: 'me@gmail.com', referralCode: REFERRER_CODE })
    // Hand-written, the way a pre-fix row would look.
    await makeUser('alias', { email: 'me+1@gmail.com', referredBy: REFERRER_CODE })

    const result = await rewardReferrerForFirstPurchase(db, 'alias', { now: NOW })
    expect(result.outcome).toBe('self_referral')
    expect(await findActiveEntitlement(db, 'self')).toBeNull()

    const welcome = await grantRefereeWelcome(
      db,
      { id: 'alias', email: 'me+1@gmail.com', referredBy: REFERRER_CODE },
      { sessionPassword: LEGACY_SALT },
    )
    expect(welcome.outcome).toBe('self_referral')
  })

  it('still allows two genuinely different mailboxes', async () => {
    await makeUser('referrer', { email: 'ada@example.com', referralCode: REFERRER_CODE })
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'grace@example.com' },
      { referralCode: REFERRER_CODE },
    )
    expect(user.referredBy).toBe(REFERRER_CODE)
  })
})

// ── The welcome grant is spent per mailbox, not per account ─────────────────

describe('deleting an account does not refill the welcome trial', () => {
  it('grants nothing the second time the same address signs up', async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })

    const first = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'boomerang@example.com' },
      { referralCode: REFERRER_CODE },
    )
    expect(
      (await grantRefereeWelcome(db, first.user, { sessionPassword: LEGACY_SALT })).outcome,
    ).toBe('granted')

    // Deletion anonymizes the row and frees the address, so the next sign-in
    // takes the INSERT branch and mints a brand-new user id. Keyed on that id,
    // the ref would be fresh and the trial would refill — forever, with two
    // mailboxes taking turns.
    await deleteAccount(db, first.user.id)

    const second = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'boomerang@example.com' },
      { referralCode: REFERRER_CODE },
    )
    expect(second.created).toBe(true)
    expect(second.user.id).not.toBe(first.user.id)

    const again = await grantRefereeWelcome(db, second.user, { sessionPassword: LEGACY_SALT })
    expect(again.outcome).toBe('already_granted')
    expect(await findActiveEntitlement(db, second.user.id)).toBeNull()
  })

  it('keys the ref on the mailbox, so sub-addresses share one trial', async () => {
    expect(await welcomeRefForEmail('me+1@gmail.com', SALT)).toBe(
      await welcomeRefForEmail('me@gmail.com', SALT),
    )
    expect(await welcomeRefForEmail('ada@example.com', SALT)).not.toBe(
      await welcomeRefForEmail('grace@example.com', SALT),
    )
  })

  it('puts no address in the ref, and refuses to build one without a salt', async () => {
    // This string is rendered in the admin console and included in "download
    // your data", and it outlives the account. An unsalted digest of an email
    // is rainbow-tableable against any mailing list, so a missing salt refuses.
    const ref = await welcomeRefForEmail('ada@example.com', SALT)
    expect(ref).not.toContain('ada')
    expect(ref).not.toContain('@')
    expect(await welcomeRefForEmail('ada@example.com', '')).toBeNull()
  })

  it('needs no configuration at all — the salt provisions itself', async () => {
    // The whole reason the salt is a generated row rather than an env var: a
    // fork that sets nothing still gets the once-per-mailbox invariant, and
    // there is no secret anybody can rotate to reset it. sessionPassword is
    // passed only for the legacy-ref check and may be empty.
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
    const result = await grantRefereeWelcome(db, REFEREE, { sessionPassword: '' })
    expect(result.outcome).toBe('granted')
  })

  it('refuses a mailbox that spent its trial under the OLD ref construction', async () => {
    // Introducing the identity salt and the domain prefix recomputes every
    // mailbox's ref, which is itself the reset event this design exists to
    // prevent — once, at deploy. Checking the legacy ref closes that window.
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })

    const legacyRef = await legacyWelcomeRefForEmail('referee@example.com', LEGACY_SALT)
    await db.insert(schema.entitlements).values({
      userId: 'referee',
      paddleSubscriptionId: legacyRef!,
      status: 'active',
      currentPeriodEnd: new Date(atSecond(NOW.getTime() - DAY_MS)),
    })

    const result = await grantRefereeWelcome(db, REFEREE, { sessionPassword: LEGACY_SALT })
    expect(result.outcome).toBe('already_granted')
  })

  it('domain-separates the digest from the rate-limiter key', async () => {
    // Unprefixed, this was byte-identical to the magic-link per-address KV key
    // — one value meaning two things, one of them rendered in the admin console
    // and exported in "download your data".
    const bare = await saltedHash('referee@example.com', SALT)
    expect(await welcomeRefForEmail('referee@example.com', SALT)).not.toContain(bare!)
  })
})

// ── Reading it back ─────────────────────────────────────────────────────────

describe('getReferralSummary', () => {
  it('mints a code for an account that predates the column', async () => {
    // Nullable on purpose: backfilling would have handed codes to dormant
    // accounts. The mint happens the first time somebody opens the card.
    await makeUser('legacy')
    const summary = await getReferralSummary(db, 'legacy')

    expect(summary?.code).toBe(normalizeReferralCode(summary?.code))
    // Stable — a code somebody has already shared must survive a second read.
    expect((await getReferralSummary(db, 'legacy'))?.code).toBe(summary?.code)
  })

  it('keeps the code an account already has', async () => {
    await makeUser('holder', { referralCode: REFERRER_CODE })
    expect((await getReferralSummary(db, 'holder'))?.code).toBe(REFERRER_CODE)
  })

  it('counts signups and rewards separately, because they are different numbers', async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('a', { referredBy: REFERRER_CODE })
    await makeUser('b', { referredBy: REFERRER_CODE })
    await rewardReferrerForFirstPurchase(db, 'a', { now: NOW })

    const summary = await getReferralSummary(db, 'referrer')
    expect(summary).toMatchObject({ referredCount: 2, rewardedCount: 1 })
  })

  it('returns null for a session naming a row that is gone', async () => {
    expect(await getReferralSummary(db, 'never-existed')).toBeNull()
  })
})

describe('ensureReferralCode', () => {
  it('retries onto a fresh code when the first one is taken', async () => {
    // The same unique-index collision provisioning handles, on the lazy path.
    // Forced through the real driver, because the recovery turns on matching an
    // error string D1 produces and that cannot be verified by reading it.
    await makeUser('holder', { referralCode: 'TAKEN123' })
    await makeUser('latecomer')

    const codes = ['TAKEN123', 'FRESH456']
    let calls = 0
    const mintCode = () => codes[calls++] ?? generateReferralCode()

    expect(await ensureReferralCode(db, 'latecomer', mintCode)).toBe('FRESH456')
    expect(calls).toBe(2)
  })
})
