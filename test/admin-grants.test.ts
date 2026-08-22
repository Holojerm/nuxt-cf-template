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
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { MAX_COMP_PASSES } from '../shared/utils/comps'
import {
  COMP_REVOKED_STATUS,
  grantCompPasses,
  revokeCompPass,
} from '../server/utils/admin-grants'
import { PASS_DAYS, findActiveEntitlement, getBillingOverview } from '../server/utils/entitlements'
import { COMP_REF_PREFIX, compRef, isCompRef, isPass } from '../server/utils/paddle-refs'
import { deriveBillingState } from '../server/utils/billing-state'

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
    expect(result.endsAt!.getTime()).toBe(daysFrom(NOW, PASS_DAYS))

    const active = await findActiveEntitlement(db, USER)
    expect(active?.paddleSubscriptionId).toBe(result.refs[0])
    expect(active?.status).toBe('active')
  })

  it('stacks several passes in one grant instead of overwriting', async () => {
    const result = await grantCompPasses(db, { userId: USER, passes: 3, now: NOW })

    expect(result.refs).toHaveLength(3)
    expect(result.days).toBe(3 * PASS_DAYS)
    expect(result.endsAt!.getTime()).toBe(daysFrom(NOW, 3 * PASS_DAYS))

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
    expect(second.stackedOn?.getTime()).toBe(first.endsAt!.getTime())
    expect(second.endsAt!.getTime()).toBe(daysFrom(NOW, 2 * PASS_DAYS))
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
    expect(result.endsAt!.getTime()).toBe(daysFrom(paidUntil, PASS_DAYS))
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
    expect(result.endsAt!.getTime()).toBe(daysFrom(NOW, PASS_DAYS))
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

describe('a live subscriber is refused, not silently served', () => {
  // The money bug this exists to stop: comp days stack from the subscription's
  // RENEWAL date, and that window is exactly what the customer's next payment
  // already buys. The grant delivers zero days unless the subscription ends —
  // while the comp row simultaneously outranks the subscription in
  // findActiveEntitlement's ORDER BY and makes /account call a paying monthly
  // customer a one-time pass holder.

  async function liveSubscription(status = 'active') {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_live',
      status,
      currentPeriodEnd: new Date(daysFrom(NOW, 20)),
    })
  }

  it('refuses and names the subscription blocking it', async () => {
    await liveSubscription()

    const result = await grantCompPasses(db, { userId: USER, passes: 2, now: NOW })

    expect(result.outcome).toBe('active_subscription')
    expect(result.blockedBy).toBe('sub_live')
    expect(result.refs).toEqual([])
    expect(result.days).toBe(0)
    expect(result.endsAt).toBeNull()
  })

  it('writes nothing at all when it refuses', async () => {
    await liveSubscription()
    await grantCompPasses(db, { userId: USER, passes: 3, now: NOW })

    const { history } = await getBillingOverview(db, USER)
    expect(history.filter((row) => isCompRef(row.paddleSubscriptionId))).toHaveLength(0)
  })

  it('sees the subscription even when an older comp outranks it by date', async () => {
    // findActiveEntitlement returns ONE row ordered by end date, so a comp
    // stacked past the renewal hides the subscription from it. The check scans
    // the whole history instead — otherwise the bug simply repeats.
    await liveSubscription()
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: compRef(),
      status: 'active',
      currentPeriodEnd: new Date(daysFrom(NOW, 400)),
    })

    const result = await grantCompPasses(db, { userId: USER, now: NOW })
    expect(result.outcome).toBe('active_subscription')
  })

  it('still allows a comp during dunning, where the days are real', async () => {
    // past_due is outside ACTIVE_STATUSES, so access is already paused and comp
    // days are genuine days. "Here's a week while you sort the card out" is a
    // real support action and must not be blocked along with the active case.
    await liveSubscription('past_due')

    const result = await grantCompPasses(db, { userId: USER, now: NOW })

    expect(result.outcome).toBe('granted')
    expect(result.endsAt!.getTime()).toBe(daysFrom(NOW, PASS_DAYS))
  })

  it('allows a comp once the subscription has ended', async () => {
    await liveSubscription('canceled')
    expect((await grantCompPasses(db, { userId: USER, now: NOW })).outcome).toBe('granted')
  })
})

describe('a multi-pass grant is all-or-nothing', () => {
  it('writes every pass in one batch with the dates stacked', async () => {
    const result = await grantCompPasses(db, { userId: USER, passes: 4, now: NOW })

    const { history } = await getBillingOverview(db, USER)
    expect(history).toHaveLength(4)
    // The precomputed arithmetic must land on exactly what the old
    // re-read-per-pass loop produced: each pass extends the previous end.
    const ends = history.map((row) => row.currentPeriodEnd!.getTime()).sort((a, b) => a - b)
    expect(ends).toEqual([1, 2, 3, 4].map((n) => daysFrom(NOW, n * PASS_DAYS)))
    expect(result.endsAt!.getTime()).toBe(daysFrom(NOW, 4 * PASS_DAYS))
  })

  it('writes nothing when the batch cannot land', async () => {
    // `entitlements.user_id` is a real foreign key, so the whole batch fails.
    // The property under test is the one the console's error copy rests on: a
    // failed grant leaves no partial access behind. A loop of N independent
    // inserts could not promise that, and the toast claimed it anyway.
    await expect(
      grantCompPasses(db, { userId: 'no-such-user', passes: 5, now: NOW }),
    ).rejects.toThrow()

    const orphans = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, 'no-such-user'))
    expect(orphans).toHaveLength(0)
  })
})

describe('the sub_ fast path is not reachable by a lookalike ref', () => {
  it('does not treat `subs_fake` as a subscription', async () => {
    // `like(col, 'sub_%')` — the obvious spelling — reads `_` as "any single
    // character", so this ref lands on the branch that grants access WITHOUT
    // checking the expiry. Expired a year ago and still granting, forever.
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'subs_fake',
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() - 365 * DAY_MS),
    })

    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('still lets a real subscription through on status alone', async () => {
    // The other half: escaping must not break the case it exists to protect.
    // A live `sub_` row has no meaningful date here and must still grant.
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_real',
      status: 'active',
      currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY_MS),
    })

    const active = await findActiveEntitlement(db, USER)
    expect(active?.paddleSubscriptionId).toBe('sub_real')
  })
})

describe('revoking a comp', () => {
  /** The row as the table holds it, for asserting what a revoke did to it. */
  async function rowFor(ref: string) {
    return db.query.entitlements.findFirst({
      where: eq(schema.entitlements.paddleSubscriptionId, ref),
    })
  }

  it('ends access and expires the window, not just the status', async () => {
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    const ref = refs[0]!

    const result = await revokeCompPass(db, { userId: USER, ref, now: NOW })

    expect(result.outcome).toBe('revoked')
    expect(result.revokedEndsAt?.getTime()).toBe(daysFrom(NOW, PASS_DAYS))
    expect(result.remainingEndsAt).toBeNull()

    const row = await rowFor(ref)
    expect(row?.status).toBe(COMP_REVOKED_STATUS)
    // Both halves, deliberately. The status is what the app's allowlist reads;
    // the date is what anything checking only the window reads (the MCP
    // worker's raw SQL). If they disagreed, one surface would still grant.
    expect(row?.currentPeriodEnd?.getTime()).toBeLessThanOrEqual(NOW.getTime())

    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('leaves the customer another comp and a paid pass untouched', async () => {
    // The regression that matters most: a revoke aimed at one row must not be
    // a revoke of everything the account has.
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_paid',
      status: 'active',
      currentPeriodEnd: new Date(daysFrom(NOW, 10)),
    })
    const first = await grantCompPasses(db, { userId: USER, now: NOW })
    const second = await grantCompPasses(db, { userId: USER, now: NOW })
    const keep = first.refs[0]!
    const drop = second.refs[0]!

    await revokeCompPass(db, { userId: USER, ref: drop, now: NOW })

    expect((await rowFor(drop))?.status).toBe(COMP_REVOKED_STATUS)
    expect((await rowFor(keep))?.status).toBe('active')
    expect((await rowFor('txn_paid'))?.status).toBe('active')

    // Access survives, from the rows that were not targeted.
    const active = await findActiveEntitlement(db, USER)
    expect(active).not.toBeNull()
    expect(active?.paddleSubscriptionId).toBe(keep)
  })

  it('refuses a subscription or a paid pass — Paddle owns those', async () => {
    for (const ref of ['sub_live', 'txn_paid']) {
      await db.insert(schema.entitlements).values({
        userId: USER,
        paddleSubscriptionId: ref,
        status: 'active',
        currentPeriodEnd: new Date(daysFrom(NOW, 10)),
      })

      const result = await revokeCompPass(db, { userId: USER, ref, now: NOW })

      expect(result.outcome).toBe('not_comp')
      // Untouched: revoking money-backed access locally would either be
      // overwritten by the next Paddle event or take away something the
      // customer actually bought, with no refund attached.
      expect((await rowFor(ref))?.status).toBe('active')
    }
  })

  it('will not revoke across accounts', async () => {
    await db
      .insert(schema.users)
      .values({ id: 'user-2', email: 'user-2@example.com', name: 'user-2' })
      .onConflictDoNothing()
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    const ref = refs[0]!

    // The ref is real, but it is not this user's — `user_id` is part of the
    // WHERE precisely so a leaked ref cannot reach another account.
    const result = await revokeCompPass(db, { userId: 'user-2', ref, now: NOW })

    expect(result.outcome).toBe('not_found')
    expect((await rowFor(ref))?.status).toBe('active')
  })

  it('leaves an already-expired comp completely alone', async () => {
    // Nothing flips a comp's status when its window closes, so an expired comp
    // still reads `status: 'active'` and the Revoke control used to render for
    // it. Revoking then set `current_period_end = now`, dragging a date months
    // in the PAST forward to today — rewriting history to say the customer had
    // access for longer than they did, on a row granting nothing either way.
    const grantedAt = new Date(NOW.getTime() - 90 * DAY_MS)
    const { refs } = await grantCompPasses(db, { userId: USER, now: grantedAt })
    const ref = refs[0]!
    const before = await rowFor(ref)
    expect(await findActiveEntitlement(db, USER)).toBeNull()

    const result = await revokeCompPass(db, { userId: USER, ref, now: NOW })

    expect(result.outcome).toBe('already_expired')

    const after = await rowFor(ref)
    expect(after?.currentPeriodEnd?.getTime()).toBe(before?.currentPeriodEnd?.getTime())
    expect(after?.currentPeriodEnd!.getTime()).toBeLessThan(NOW.getTime())
    expect(after?.status).toBe('active')
  })

  it('reports an unknown ref rather than pretending it worked', async () => {
    const result = await revokeCompPass(db, { userId: USER, ref: compRef(), now: NOW })
    expect(result.outcome).toBe('not_found')
  })

  it('is idempotent — a second revoke is a no-op, not a re-dated one', async () => {
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    const ref = refs[0]!

    await revokeCompPass(db, { userId: USER, ref, now: NOW })
    const firstEnd = (await rowFor(ref))?.currentPeriodEnd?.getTime()

    const again = await revokeCompPass(db, {
      userId: USER,
      ref,
      now: new Date(NOW.getTime() + DAY_MS),
    })

    expect(again.outcome).toBe('already_revoked')
    // A second write would push current_period_end a day into the future —
    // briefly re-granting the access the first revoke removed.
    expect((await rowFor(ref))?.currentPeriodEnd?.getTime()).toBe(firstEnd)
  })

  it('reports what access is left when other rows survive', async () => {
    const paidUntil = new Date(daysFrom(NOW, 10))
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_paid',
      status: 'active',
      currentPeriodEnd: paidUntil,
    })
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })

    const result = await revokeCompPass(db, { userId: USER, ref: refs[0]!, now: NOW })

    // Support reads this line out loud: "you still have until the 14th."
    expect(result.remainingEndsAt?.getTime()).toBe(paidUntil.getTime())
  })

  it('keeps the revoked row in billing history rather than deleting it', async () => {
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    const ref = refs[0]!
    await revokeCompPass(db, { userId: USER, ref, now: NOW })

    const { history, active } = await getBillingOverview(db, USER)

    // It happened, so it stays visible — as a comp that was granted and
    // withdrawn, which is what the customer's history should show.
    expect(history.map((row) => row.paddleSubscriptionId)).toContain(ref)
    expect(active).toBeNull()
  })

  it('leaves the account reading as inactive, not as a payment problem', async () => {
    const { refs } = await grantCompPasses(db, { userId: USER, now: NOW })
    await revokeCompPass(db, { userId: USER, ref: refs[0]!, now: NOW })

    const { history, active } = await getBillingOverview(db, USER)

    // A revoked comp must not be mistaken for dunning: there was never a card
    // behind it, so telling this customer to update a payment method would be
    // an invented problem. deriveBillingState only reads past_due off a
    // subscription, and this asserts the comp path agrees.
    expect(deriveBillingState(active, history)).toBe('inactive')
  })
})
