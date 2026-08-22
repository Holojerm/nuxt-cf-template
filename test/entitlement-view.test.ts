// The wire shape every billing surface reads, driven against a real D1.
//
// buildEntitlementView() is the one description of a customer's billing state —
// /api/billing/entitlement, the admin console's user detail, and its read-only
// "view as" all return it. test/billing-state.test.ts already proves the
// derivation itself; what it cannot prove is that the derivation is still
// PLUMBED, and that is the failure this file exists for.
//
// Without it, deleting `state` from the view deletes the entire dunning
// surface — the layout banner, the /account treatment, and the support
// console's reason-for-no-access — while every other test in the repo stays
// green. The customer's card silently goes back to being something the product
// never mentions, which is precisely the bug the dunning work was written to
// fix.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { buildEntitlementView } from '../server/utils/entitlement-view'
import { compRef } from '../server/utils/paddle-refs'

const db = drizzle(env.DB, { schema })

const USER = 'user-1'
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await db.delete(schema.entitlements)
  await db
    .insert(schema.users)
    .values({ id: USER, email: `${USER}@example.com`, name: USER })
    .onConflictDoNothing()
})

function insert(ref: string, status: string, endsInDays: number) {
  return db.insert(schema.entitlements).values({
    userId: USER,
    paddleCustomerId: 'ctm_1',
    paddleSubscriptionId: ref,
    productKey: 'default',
    status,
    currentPeriodEnd: new Date(Date.now() + endsInDays * DAY_MS),
  })
}

describe('buildEntitlementView — state reaches the wire', () => {
  it('reports past_due with no access when a subscription payment failed', async () => {
    // The pair is the whole point: `active: false` is what the gate enforces,
    // `state: 'past_due'` is what lets the UI say why instead of offering to
    // sell the customer the plan they are already paying for.
    await insert('sub_1', 'past_due', -1)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.active).toBe(false)
    expect(view.state).toBe('past_due')
    // Still reachable: the portal is where the card gets fixed, and a past_due
    // customer whose only route to it is a dead button has no route to it.
    expect(view.portalAvailable).toBe(true)
  })

  it('reports active for a live subscription', async () => {
    // Guards the other direction — a view that hardcoded 'past_due', or read
    // the status off the wrong row, would still pass the test above.
    await insert('sub_1', 'active', 30)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.active).toBe(true)
    expect(view.state).toBe('active')
  })

  it('reports inactive once a subscription is cancelled', async () => {
    await insert('sub_1', 'canceled', -1)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.state).toBe('inactive')
  })

  it('never reports a comped grant as past_due', async () => {
    // A comp has no card behind it. `state` and `comped` are orthogonal facts
    // about the same row, and confusing them sends someone to a billing portal
    // to fix access that support gave them for free.
    await insert(compRef(), 'past_due', -1)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.state).toBe('inactive')
  })

  it('lets a live comp outrank a past_due subscription', async () => {
    // Access is genuinely still granted, so "your access is paused" would be a
    // lie — and the row that grants it is the comped one.
    await insert('sub_1', 'past_due', -1)
    await insert(compRef(), 'active', 14)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.active).toBe(true)
    expect(view.state).toBe('active')
    expect(view.comped).toBe(true)
  })
})

describe('buildEntitlementView — a live subscription describes the account', () => {
  // The bug: findActiveEntitlement orders by `current_period_end DESC`, so a
  // comp stacked past a subscription's renewal outranked it — and /account told
  // a paying monthly customer "You have a one-time pass. It will not renew."
  // beside a working "Manage or cancel" button for the subscription the same
  // page had just decided did not exist.
  //
  // grantCompPasses now refuses that combination outright, but the pair can
  // still arrive the other way round (comp first, subscribe second), so the
  // description has to be right independently of how the rows got there.

  it('calls a subscriber a subscriber even when a comp ends later', async () => {
    await insert('sub_1', 'active', 20)
    await insert(compRef(), 'active', 400)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.kind).toBe('subscription')
    expect(view.comped).toBe(false)
    expect(view.cancellable).toBe(1)
    expect(view.active).toBe(true)
    expect(view.state).toBe('active')
    // The renewal date, not the comp's far-future expiry: /account labels this
    // field "Renews", and pointing it at the comp promises a renewal on a date
    // nothing renews.
    const days = (new Date(view.currentPeriodEnd!).getTime() - Date.now()) / DAY_MS
    expect(Math.round(days)).toBe(20)
  })

  it('still describes the comp when the only subscription is past_due', async () => {
    // Dunning puts the subscription outside ACTIVE_STATUSES, so the comp really
    // is what grants access here and should say so.
    await insert('sub_1', 'past_due', -1)
    await insert(compRef(), 'active', 14)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.kind).toBe('pass')
    expect(view.comped).toBe(true)
  })

  it('describes the comp when there is no subscription at all', async () => {
    await insert(compRef(), 'active', 14)

    const view = await buildEntitlementView(db, USER, { portalConfigured: true })

    expect(view.kind).toBe('pass')
    expect(view.comped).toBe(true)
  })

  it('hides the portal when the API key is unset, whatever the customer holds', async () => {
    await insert('sub_1', 'active', 20)

    const view = await buildEntitlementView(db, USER, { portalConfigured: false })

    expect(view.portalAvailable).toBe(false)
  })
})
