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
  countReferralRewards,
  ensureReferralCode,
  getReferralSummary,
  grantRefereeWelcome,
  rewardReferrerForFirstPurchase,
} from '../server/utils/referral'
import { PASS_DAYS, findActiveEntitlement } from '../server/utils/entitlements'
import { isReferralRef, referralRewardRef, referralWelcomeRef } from '../server/utils/paddle-refs'
import { generateReferralCode, upsertOAuthUser } from '../server/utils/users'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const REFERRER_CODE = 'AB2CD3EF'

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
    const welcome = await grantRefereeWelcome(db, user)
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
    const result = await grantRefereeWelcome(db, {
      id: 'referee',
      email: 'referee@example.com',
      referredBy: REFERRER_CODE,
    })

    expect(result.outcome).toBe('granted')
    expect(result.days).toBe(REFERRAL_WELCOME_DAYS)

    const granting = await findActiveEntitlement(db, 'referee')
    expect(granting?.paddleSubscriptionId).toBe(referralWelcomeRef('referee'))
    // The referrer is paid on the referee's first PURCHASE and not before.
    expect(await findActiveEntitlement(db, 'referrer')).toBeNull()
  })

  it('grants once per account, however many times it is called', async () => {
    const first = await grantRefereeWelcome(db, {
      id: 'referee',
      email: 'referee@example.com',
      referredBy: REFERRER_CODE,
    })
    const second = await grantRefereeWelcome(db, {
      id: 'referee',
      email: 'referee@example.com',
      referredBy: REFERRER_CODE,
    })

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
    const result = await grantRefereeWelcome(db, {
      id: 'organic',
      email: 'organic@example.com',
      referredBy: null,
    })
    expect(result.outcome).toBe('no_referrer')
    expect(await findActiveEntitlement(db, 'organic')).toBeNull()
  })

  it('refuses a code that no live account holds', async () => {
    await makeUser('orphan', { referredBy: 'ZZ9YY8XX' })
    const result = await grantRefereeWelcome(db, {
      id: 'orphan',
      email: 'orphan@example.com',
      referredBy: 'ZZ9YY8XX',
    })
    expect(result.outcome).toBe('referrer_unresolved')
    expect(await findActiveEntitlement(db, 'orphan')).toBeNull()
  })

  it('refuses an account that names its own code', async () => {
    await makeUser('narcissus', { referralCode: 'TT2VV3WW', referredBy: 'TT2VV3WW' })
    const result = await grantRefereeWelcome(db, {
      id: 'narcissus',
      email: 'narcissus@example.com',
      referredBy: 'TT2VV3WW',
    })
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
      paddleSubscriptionId: referralWelcomeRef('referrer'),
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
    })
    expect(await countReferralRewards(db, 'referrer')).toBe(0)
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

  it('pays nothing to a live subscriber, because the days would deliver nothing', async () => {
    // Inherited from grantCompPasses: days stack from the current expiry, and
    // for a subscriber that expiry is the renewal their next payment buys. A
    // grant that hands over zero days while saying "you earned 30" is worse
    // than no grant.
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: 'sub_live',
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY_MS),
    })

    const result = await rewardReferrerForFirstPurchase(db, 'referee', { now: NOW })
    expect(result.outcome).toBe('active_subscription')

    const rows = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.paddleSubscriptionId, referralRewardRef('referee')))
    expect(rows).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
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
