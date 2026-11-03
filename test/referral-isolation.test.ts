// The referral loop and the billing layer are separate features that meet only
// at core's seams. This pins what each does when the other is absent, so a fork
// can vendor one without the other and the template keeps working with neither.
//
//   both          test/referral.test.ts (the whole loop, against real entitlements)
//   referral only here: codes are captured and attributed, nothing is granted
//   billing only  here: the webhook and the billing view carry no referral
//   neither       here, plus test/extensions.test.ts for the rest of core

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { buildEntitlementView } from '#layers/billing/server/utils/entitlement-view'
import { billingEarnedAccess } from '#layers/billing/server/utils/billing-earned-access'
import {
  clearBillingOutcomeHandlersForTest,
  registerBillingOutcomeHandler,
  runBillingOutcomeHandlers,
} from '../server/utils/billing-outcome'
import { clearExtensionsForTest } from '../server/utils/extensions'
import { getEarnedAccess, registerEarnedAccess } from '../server/utils/earned-access'
import { createReferralOutcomeHandler } from '../server/utils/referral-billing'
import {
  countReferralRewards,
  getReferralSummary,
  grantRefereeWelcome,
  rewardReferrerForFirstPurchase,
} from '../server/utils/referral'
import { createReferralSignup } from '../server/utils/referral-signup'
import { upsertOAuthUser } from '../server/utils/users'

const db = drizzle(env.DB, { schema })
const CODE = 'AB2CD3EF'

beforeEach(async () => {
  clearExtensionsForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db
    .insert(schema.users)
    .values({ id: 'referrer', email: 'referrer@example.com', name: 'R', referralCode: CODE })
})

afterEach(() => {
  clearExtensionsForTest()
  vi.restoreAllMocks()
})

describe('referral without billing', () => {
  it('captures the code and attributes the new account to its holder', async () => {
    const { user, created } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'new@example.com' },
      { referralCode: CODE },
      { contributors: [createReferralSignup()] },
    )
    expect(created).toBe(true)
    expect(user.referredBy).toBe(CODE)
    expect(user.referralCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
  })

  it('grants the welcome days to nobody, and says why', async () => {
    expect(getEarnedAccess()).toBeNull()
    await db
      .insert(schema.users)
      .values({ id: 'ref', email: 'ref@example.com', name: 'ref', referredBy: CODE })

    const result = await grantRefereeWelcome(db, {
      id: 'ref',
      email: 'ref@example.com',
      referredBy: CODE,
    })

    expect(result.outcome).toBe('unavailable')
    expect(await db.query.entitlements.findMany()).toEqual([])
    expect(await db.query.auditLog.findMany()).toEqual([])
  })

  it('pays the referrer nothing when the referee pays, without an error', async () => {
    await db
      .insert(schema.users)
      .values({ id: 'ref', email: 'ref@example.com', name: 'ref', referredBy: CODE })

    const result = await rewardReferrerForFirstPurchase(db, 'ref', { earnedFromRef: 'txn_1' })

    expect(result.outcome).toBe('unavailable')
    expect(await db.query.entitlements.findMany()).toEqual([])
  })

  it('still reads the loop back: a code, who joined, nothing earned', async () => {
    await db
      .insert(schema.users)
      .values({ id: 'ref', email: 'ref@example.com', name: 'ref', referredBy: CODE })

    expect(await countReferralRewards(db, 'referrer')).toBe(0)
    expect(await getReferralSummary(db, 'referrer')).toEqual({
      code: CODE,
      referredCount: 1,
      rewardedCount: 0,
    })
  })

  it('has a handler that does nothing harmful when the webhook runs it', async () => {
    registerBillingOutcomeHandler('referral', createReferralOutcomeHandler())
    await db
      .insert(schema.users)
      .values({ id: 'ref', email: 'ref@example.com', name: 'ref', referredBy: CODE })

    await runBillingOutcomeHandlers({
      db,
      event: {
        event_id: 'e1',
        event_type: 'transaction.completed',
        occurred_at: '',
        data: { id: 'txn_1' },
      },
      outcome: { kind: 'pass', userId: 'ref', granted: true, endsAt: new Date(), stackedOn: null },
    })

    expect(await db.query.entitlements.findMany()).toEqual([])
  })
})

describe('billing without referral', () => {
  beforeEach(() => registerEarnedAccess(billingEarnedAccess))

  it('has no referral fields on the billing view', async () => {
    await db.insert(schema.entitlements).values({
      userId: 'referrer',
      paddleSubscriptionId: 'txn_1',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    })

    const view = await buildEntitlementView(db, 'referrer')

    expect('referralKind' in view).toBe(false)
    expect(view.history.every((row) => !('referral' in row) && !('referralKind' in row))).toBe(true)
  })

  it('runs the webhook’s outcome handlers as a no-op', async () => {
    await expect(
      runBillingOutcomeHandlers({
        db,
        event: { event_id: 'e1', event_type: 'x', occurred_at: '', data: { id: 'txn_1' } },
        outcome: { kind: 'ignored', reason: 'unhandled_event' },
      }),
    ).resolves.toBeUndefined()
  })

  it('does not touch the earned-access provider on its own', async () => {
    const spy = vi.spyOn(billingEarnedAccess, 'write')
    clearBillingOutcomeHandlersForTest()
    await runBillingOutcomeHandlers({
      db,
      event: { event_id: 'e1', event_type: 'x', occurred_at: '', data: { id: 'txn_1' } },
      outcome: {
        kind: 'pass',
        userId: 'referrer',
        granted: true,
        endsAt: new Date(),
        stackedOn: null,
      },
    })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('neither', () => {
  it('creates an account with no referral code and no referrer', async () => {
    const { user } = await upsertOAuthUser(
      db,
      { provider: 'email', email: 'plain@example.com' },
      { referralCode: CODE },
    )
    expect(user.referralCode).toBeNull()
    expect(user.referredBy).toBeNull()
  })
})
