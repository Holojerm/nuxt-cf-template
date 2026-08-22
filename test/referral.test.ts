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
import { withReferralCode } from '../shared/utils/attribution'
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
  REFERRAL_REVOKED_STATUS,
  countReferralRewards,
  ensureReferralCode,
  getReferralSummary,
  grantRefereeWelcome,
  revokeReferralRewardForReferee,
  rewardReferrerForFirstPurchase,
  welcomeRefForEmail,
} from '../server/utils/referral'
import { COMP_REVOKED_STATUS } from '../server/utils/admin-grants'
import { deleteAccount } from '../server/utils/account'
import { revokeForAdjustment } from '../server/utils/entitlements'
import { PASS_DAYS, findActiveEntitlement, grantPass } from '../server/utils/entitlements'
import { buildEntitlementView } from '../server/utils/entitlement-view'
import { isReferralRef, referralRewardRef, referralWelcomeRef } from '../server/utils/paddle-refs'
import { generateReferralCode, upsertOAuthUser } from '../server/utils/users'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const REFERRER_CODE = 'AB2CD3EF'

/** Stands in for `sessionPassword` — the welcome ref is a salted mailbox hash. */
const SALT = 'test-session-password'

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
    const welcome = await grantRefereeWelcome(db, user, { salt: SALT })
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

  it('never overwrites the row’s code with the redeeming browser’s', () => {
    // The fill-only rule, stated as the attack it prevents: a borrowed or
    // shared browser must not be able to re-credit somebody else's invite onto
    // a link that already names a referrer.
    const rowCarried = { source: 'referral', medium: 'invite', referralCode: REFERRER_CODE }
    expect(withReferralCode(rowCarried, 'ZZ9YY8XX')?.referralCode).toBe(REFERRER_CODE)

    // A pre-column row carries null, and there the cookie is the last copy.
    const legacyRow = { source: 'referral', medium: 'invite' }
    expect(withReferralCode(legacyRow, REFERRER_CODE)?.referralCode).toBe(REFERRER_CODE)
  })
})

// ── The referee's welcome grant ─────────────────────────────────────────────

describe('grantRefereeWelcome', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  it('grants the welcome days to the referee, not the referrer', async () => {
    const result = await grantRefereeWelcome(db, REFEREE, { salt: SALT })

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
    const first = await grantRefereeWelcome(db, REFEREE, { salt: SALT })
    const second = await grantRefereeWelcome(db, REFEREE, { salt: SALT })

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
      { salt: SALT },
    )
    expect(result.outcome).toBe('no_referrer')
    expect(await findActiveEntitlement(db, 'organic')).toBeNull()
  })

  it('refuses a code that no live account holds', async () => {
    await makeUser('orphan', { referredBy: 'ZZ9YY8XX' })
    const result = await grantRefereeWelcome(
      db,
      { id: 'orphan', email: 'orphan@example.com', referredBy: 'ZZ9YY8XX' },
      { salt: SALT },
    )
    expect(result.outcome).toBe('referrer_unresolved')
    expect(await findActiveEntitlement(db, 'orphan')).toBeNull()
  })

  it('refuses an account that names its own code', async () => {
    await makeUser('narcissus', { referralCode: 'TT2VV3WW', referredBy: 'TT2VV3WW' })
    const result = await grantRefereeWelcome(
      db,
      { id: 'narcissus', email: 'narcissus@example.com', referredBy: 'TT2VV3WW' },
      { salt: SALT },
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
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    await revokeReferralRewardForReferee(db, 'referee', { now: NOW })
    expect(await countReferralRewards(db, 'referrer')).toBe(1)
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

// ── Refund clawback ─────────────────────────────────────────────────────────
// The hole that made the loop's cost story false. revokeForAdjustment matches
// Paddle's own transaction and subscription ids; the referrer's reward carries
// neither, so refunded money still bought 30 days. Buy → collect → refund, on
// repeat, was unlimited free access.

describe('revokeReferralRewardForReferee', () => {
  beforeEach(async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
  })

  it('takes the days back, and says so in the audit trail', async () => {
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()

    const result = await revokeReferralRewardForReferee(db, 'referee', { now: NOW })
    expect(result.outcome).toBe('revoked')
    expect(result.referrerId).toBe('referrer')

    // Both halves, exactly as revokeForAdjustment and revokeCompPass write
    // them: the status is what the app's allowlist reads, the date is what
    // anything checking only the window reads, and they must agree.
    const [row] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(row?.status).toBe(REFERRAL_REVOKED_STATUS)
    expect(row?.currentPeriodEnd?.getTime()).toBeLessThanOrEqual(NOW.getTime())
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()

    const revokedAudit = (await db.select().from(schema.auditLog)).find(
      (entry) => entry.action === 'referral.revoked',
    )
    expect(revokedAudit?.actorType).toBe('system')
    expect(revokedAudit?.targetId).toBe('referrer')
  })

  it('closes the buy-collect-refund loop end to end, through the real adjustment path', async () => {
    // The scenario in full: the referee buys a pass, the referrer is paid, the
    // referee refunds the same day. Driven through revokeForAdjustment so the
    // wiring in the webhook is the only thing not exercised here.
    await grantPass(db, { userId: 'referee', transactionId: 'txn_refunded', billedAt: NOW })
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect(await findActiveEntitlement(db, 'referrer')).not.toBeNull()

    const adjustment = await revokeForAdjustment(db, {
      action: 'refund',
      status: 'approved',
      transactionId: 'txn_refunded',
    })
    expect(adjustment).toMatchObject({ outcome: 'revoked', userId: 'referee' })

    // …which is the exact hand-off the webhook makes.
    await revokeReferralRewardForReferee(db, adjustment.userId!, { now: NOW })

    expect(await findActiveEntitlement(db, 'referee')).toBeNull()
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()
  })

  it('is idempotent across a redelivered adjustment', async () => {
    await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect((await revokeReferralRewardForReferee(db, 'referee', { now: NOW })).outcome).toBe(
      'revoked',
    )
    expect((await revokeReferralRewardForReferee(db, 'referee', { now: NOW })).outcome).toBe(
      'already_revoked',
    )
  })

  it('leaves an already-expired reward completely alone', async () => {
    // Writing `current_period_end = now` on a window that closed months ago
    // would drag a past date FORWARD — rewriting history to say the referrer
    // had access longer than they did. It also gives the policy a sensible
    // edge: a chargeback on month seven does not punish the referrer.
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: referralRewardRef('referee'),
      status: 'active',
      currentPeriodEnd: new Date(atSecond(NOW.getTime() - 200 * DAY_MS)),
    })

    const result = await revokeReferralRewardForReferee(db, 'referee', { now: NOW })
    expect(result.outcome).toBe('already_expired')

    const [row] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(row?.currentPeriodEnd?.getTime()).toBe(atSecond(NOW.getTime() - 200 * DAY_MS))
    expect(row?.status).toBe('active')
  })

  it('says nothing happened when there was no reward to take back', async () => {
    // A refund from a customer nobody referred — the common case by far.
    expect((await revokeReferralRewardForReferee(db, 'referee', { now: NOW })).outcome).toBe(
      'not_found',
    )
  })

  it('never touches a Paddle row', async () => {
    // Only ever `referral_<refereeId>`. A `sub_`/`txn_` row is money Paddle
    // owns: a local status on one is either overwritten by the next webhook or
    // takes away access somebody paid for.
    await grantPass(db, { userId: 'referee', transactionId: 'txn_kept', billedAt: NOW })
    await revokeReferralRewardForReferee(db, 'referee', { now: NOW })

    const [paid] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, 'txn_kept'))
    expect(paid?.status).toBe('active')
  })

  it('spells its status the same way a revoked comp does', () => {
    // Two declarations, one value, on purpose — /account renders a single
    // `revoked` badge for both, and a second spelling would surface a bare
    // status word nobody has seen before.
    expect(REFERRAL_REVOKED_STATUS).toBe(COMP_REVOKED_STATUS)
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
      { salt: SALT },
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
    expect((await grantRefereeWelcome(db, first.user, { salt: SALT })).outcome).toBe('granted')

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

    const again = await grantRefereeWelcome(db, second.user, { salt: SALT })
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

  it('refuses the grant rather than degrading when there is no salt', async () => {
    await makeUser('referrer', { referralCode: REFERRER_CODE })
    await makeUser('referee', { referredBy: REFERRER_CODE })
    const result = await grantRefereeWelcome(db, REFEREE, { salt: '' })
    expect(result.outcome).toBe('unconfigured')
    expect(await findActiveEntitlement(db, 'referee')).toBeNull()
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
