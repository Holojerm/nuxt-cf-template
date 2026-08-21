// Comp passes — the admin console's one money-moving action, run against a
// real D1 inside workerd.
//
// Three things have to hold, and each one has a way of failing silently:
//   1. The ref never starts with `sub_`. A `sub_` ref grants access on status
//      alone, so a comp minted with that prefix is permanent free access that
//      no expiry catches and no webhook revokes.
//   2. Days stack rather than reset. Comping someone who still has paid time
//      left must not shorten what they already bought.
//   3. The grant shows up where a customer and a support person both look —
//      getBillingOverview().history — labelled as access that ends by date.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  COMP_REF_PREFIX,
  MAX_COMP_PASSES,
  compRef,
  grantCompPasses,
  isCompRef,
} from '../server/utils/admin-grants'
import { PASS_DAYS, findActiveEntitlement, getBillingOverview } from '../server/utils/entitlements'
import { isPass } from '../server/utils/billing'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const USER = 'user-1'

/** D1 timestamp columns are epoch seconds — expectations round the same way. */
function atSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

/**
 * Grants are driven at (truncated) wall-clock now rather than a fixed date.
 *
 * grantCompPasses takes an injectable `now`, but findActiveEntitlement — which
 * decides whether a row still grants access — compares current_period_end
 * against the real clock and takes no injection. Pinning this to a literal date
 * makes every assertion here depend on when the suite happens to run: the same
 * tests pass in March and fail in September.
 */
const NOW = new Date(atSecond(Date.now()))

function daysFrom(from: Date, days: number): number {
  return atSecond(from.getTime() + days * DAY_MS)
}

beforeEach(async () => {
  await db.delete(schema.entitlements)
  await db
    .insert(schema.users)
    .values({ id: USER, email: `${USER}@example.com`, name: USER })
    .onConflictDoNothing()
})

describe('the comp ref', () => {
  it('is prefixed, unique, and never looks like a subscription', () => {
    const refs = Array.from({ length: 50 }, () => compRef())

    for (const ref of refs) {
      expect(ref.startsWith(COMP_REF_PREFIX)).toBe(true)
      expect(isCompRef(ref)).toBe(true)
      // The load-bearing assertion in this file. findActiveEntitlement() grants
      // access to a `sub_` row on status alone, ignoring current_period_end.
      expect(ref.startsWith('sub_')).toBe(false)
      // Nor does it claim a Paddle transaction that revenue reconciliation
      // would go looking for and never find.
      expect(ref.startsWith('txn_')).toBe(false)
    }

    expect(new Set(refs).size).toBe(refs.length)
  })

  it('is rejected by grantCompPasses when the prefix is wrong', async () => {
    await expect(
      grantCompPasses(db, { userId: USER, passes: 1, refs: ['sub_sneaky'], now: NOW }),
    ).rejects.toThrow(/must start with/)

    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })
})

describe('granting', () => {
  it('gives one pass of access from today when there is none', async () => {
    const result = await grantCompPasses(db, { userId: USER, now: NOW })

    expect(result.passes).toBe(1)
    expect(result.days).toBe(PASS_DAYS)
    expect(result.stackedOn).toBeNull()
    expect(result.endsAt.getTime()).toBe(daysFrom(NOW, PASS_DAYS))

    const active = await findActiveEntitlement(db, USER)
    expect(active?.paddleSubscriptionId).toBe(result.refs[0])
    expect(active?.status).toBe('active')
  })

  it('stacks several passes in one grant instead of overwriting', async () => {
    const result = await grantCompPasses(db, { userId: USER, passes: 3, now: NOW })

    expect(result.refs).toHaveLength(3)
    expect(result.days).toBe(3 * PASS_DAYS)
    expect(result.endsAt.getTime()).toBe(daysFrom(NOW, 3 * PASS_DAYS))

    // Each pass is its own row, exactly like a purchased one — so reversing a
    // single comp later leaves the others alone.
    const { history } = await getBillingOverview(db, USER)
    expect(history).toHaveLength(3)
  })

  it('extends existing access rather than restarting it', async () => {
    const first = await grantCompPasses(db, { userId: USER, now: NOW })
    const second = await grantCompPasses(db, { userId: USER, now: NOW })

    // Nobody loses days they already had — the same rule a second purchased
    // pass follows (server/utils/entitlements.ts › grantPass).
    expect(second.stackedOn?.getTime()).toBe(first.endsAt.getTime())
    expect(second.endsAt.getTime()).toBe(daysFrom(NOW, 2 * PASS_DAYS))
  })

  it('stacks on top of a still-running purchased pass', async () => {
    const paidUntil = new Date(daysFrom(NOW, 10))
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_paid',
      status: 'active',
      currentPeriodEnd: paidUntil,
    })

    const result = await grantCompPasses(db, { userId: USER, now: NOW })

    expect(result.stackedOn?.getTime()).toBe(paidUntil.getTime())
    expect(result.endsAt.getTime()).toBe(daysFrom(paidUntil, PASS_DAYS))
  })

  it('starts from today when the previous access has already lapsed', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_expired',
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY_MS),
    })

    const result = await grantCompPasses(db, { userId: USER, now: NOW })

    expect(result.stackedOn).toBeNull()
    expect(result.endsAt.getTime()).toBe(daysFrom(NOW, PASS_DAYS))
  })

  it('refuses a pass count outside the bound', async () => {
    await expect(
      grantCompPasses(db, { userId: USER, passes: MAX_COMP_PASSES + 1, now: NOW }),
    ).rejects.toThrow(/between 1 and/)
    await expect(grantCompPasses(db, { userId: USER, passes: 0, now: NOW })).rejects.toThrow(
      /between 1 and/,
    )

    expect(await getBillingOverview(db, USER).then((o) => o.history)).toHaveLength(0)
  })
})

describe('how a comp reads back', () => {
  it('appears in billing history as time-limited access, not a subscription', async () => {
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    const ref = refs[0]!

    const overview = await getBillingOverview(db, USER)
    const row = overview.history.find((entry) => entry.paddleSubscriptionId === ref)

    expect(row).toBeDefined()
    expect(row?.status).toBe('active')
    // The regression this guards: keyed on `txn_`, isPass() called a comp a
    // subscription, and /account told the customer it renews automatically.
    expect(isPass(ref)).toBe(true)
    // Nothing to cancel — a comp is not an auto-renewing subscription, so it
    // must never appear in the list a cancel link targets.
    expect(overview.subscriptionIds).not.toContain(ref)
    expect(overview.subscriptionIds).toHaveLength(0)
  })

  it('stops granting access once its window closes', async () => {
    await grantCompPasses(db, { userId: USER, now: new Date(NOW.getTime() - 40 * DAY_MS) })

    // A `sub_` ref would still be granting here on status alone. This is the
    // behavioural half of the prefix rule asserted at the top of this file.
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })
})
