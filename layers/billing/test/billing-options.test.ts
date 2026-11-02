// The pieces upstreamed from forks and the knobs an app turns, in isolation:
// findActiveEntitlement's `now`, the pass length, the foreign-product test, the
// unmatched-adjustment predicate and the outcome-handler registry.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  clearBillingOutcomeHandlersForTest,
  registerBillingOutcomeHandler,
  runBillingOutcomeHandlers,
  type BillingOutcomeContext,
} from '../server/utils/billing-outcome'
import {
  PASS_DAYS,
  adjustmentMatchedNothing,
  findActiveEntitlement,
  grantPass,
  setPassDays,
} from '../server/utils/entitlements'
import { isForeignProduct } from '../server/utils/paddle-prices'

const db = drizzle(env.DB, { schema })
const USER = 'user-options'
const DAY = 86_400_000

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ id: USER, email: 'opt@example.com', name: 'Opt' })
})

afterEach(() => {
  setPassDays(30)
  clearBillingOutcomeHandlersForTest()
  vi.restoreAllMocks()
})

describe('findActiveEntitlement(…, now)', () => {
  const billed = new Date('2030-01-01T00:00:00Z')

  beforeEach(async () => {
    await grantPass(db, { userId: USER, transactionId: 'txn_a', billedAt: billed })
  })

  it('judges a pass’s expiry at the moment asked, not at the wall clock', async () => {
    // The pass runs 2030-01-01 → 2030-01-31.
    expect(
      (await findActiveEntitlement(db, USER, 'default', new Date('2030-01-15')))?.id,
    ).toBeTruthy()
    expect(await findActiveEntitlement(db, USER, 'default', new Date('2030-02-15'))).toBeNull()
  })

  it('defaults to now, so existing callers are unchanged', async () => {
    // 2030 is in the future relative to the test clock.
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('ignores `now` for a subscription: those are status-driven', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_a',
      status: 'active',
      currentPeriodEnd: new Date('2020-01-01'),
    })
    expect(
      (await findActiveEntitlement(db, USER, 'default', new Date('2090-01-01')))
        ?.paddleSubscriptionId,
    ).toBe('sub_a')
  })
})

describe('pass length', () => {
  it('defaults to 30 days', () => {
    expect(PASS_DAYS).toBe(30)
  })

  it('is applied to new passes once set', async () => {
    expect(setPassDays(14)).toBe(true)
    const billed = new Date('2030-01-01T00:00:00Z')
    const result = await grantPass(db, { userId: USER, transactionId: 'txn_b', billedAt: billed })
    expect(result.endsAt.getTime() - billed.getTime()).toBe(14 * DAY)
  })

  it.each([0, -3, 1.5, 400, Number.NaN])('ignores %s and keeps the current length', (days) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(setPassDays(days)).toBe(false)
    expect(PASS_DAYS).toBe(30)
  })
})

describe('isForeignProduct', () => {
  const item = (productId: string | null | undefined) => ({
    price: { id: 'pri_x', product_id: productId },
  })

  it('is true only when every item is on a different, known product', () => {
    expect(isForeignProduct([item('pro_b')], 'pro_a')).toBe(true)
    expect(isForeignProduct([item('pro_b'), item('pro_c')], 'pro_a')).toBe(true)
  })

  it.each([
    ['our own product', [item('pro_a')]],
    ['a basket that includes ours', [item('pro_b'), item('pro_a')]],
    ['an item with no product', [item(null)]],
    ['an item with an empty product', [item('')]],
    ['no items', []],
  ])('is false for %s', (_name, items) => {
    expect(isForeignProduct(items, 'pro_a')).toBe(false)
  })

  it('is false when no product id is configured, so the alert stays', () => {
    expect(isForeignProduct([item('pro_b')], undefined)).toBe(false)
    expect(isForeignProduct([item('pro_b')], '')).toBe(false)
  })
})

describe('adjustmentMatchedNothing', () => {
  it('is true only for no_matching_entitlement; a reversal has no user by design', () => {
    expect(adjustmentMatchedNothing({ outcome: 'no_matching_entitlement' })).toBe(true)
    expect(adjustmentMatchedNothing({ outcome: 'reversed' })).toBe(false)
    expect(adjustmentMatchedNothing({ outcome: 'revoked', userId: USER, paddleRef: 'txn_a' })).toBe(
      false,
    )
  })
})

describe('billing outcome handlers', () => {
  const context = {
    db,
    event: {},
    outcome: { kind: 'ignored', reason: 'no_user' },
  } as unknown as BillingOutcomeContext

  it('run in registration order and replace a handler registered twice under one key', async () => {
    const order: string[] = []
    registerBillingOutcomeHandler('a', async () => void order.push('a1'))
    registerBillingOutcomeHandler('b', async () => void order.push('b'))
    registerBillingOutcomeHandler('a', async () => void order.push('a2'))
    await runBillingOutcomeHandlers(context)
    expect(order).toEqual(['a2', 'b'])
  })

  it('with none registered, do nothing', async () => {
    await expect(runBillingOutcomeHandlers(context)).resolves.toBeUndefined()
  })
})
