// Billing's side of account deletion and export, against a real D1 inside
// workerd: the live-subscription deletion guard (the one friction this app adds
// to an exit, because Paddle keeps charging a deleted account otherwise), the
// retention of entitlements under the anonymized `users` row, and the
// entitlements section of the data export. Core's own deletion/export tests
// run without billing in test/account.test.ts and test/extensions.test.ts.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deleteAccount, exportAccount } from '~~/server/utils/account'
import { registerBillingExtensions } from '../server/utils/billing-extensions'
import { getBillingOverview } from '../server/utils/entitlements'

const db = drizzle(env.DB, { schema })

// Billing registers the deletion guard and the entitlements export section;
// Nitro plugins do not run under vitest, so the suite registers them itself.
beforeAll(() => registerBillingExtensions())

/** What a refusal by billing's guard looks like to deleteAccount()'s caller. */
const blockedBySubscription = (subscriptionId: string) => ({
  outcome: 'blocked' as const,
  code: 'live_subscription',
  message: expect.stringContaining('Cancel it from the billing portal first'),
  data: { subscriptionId },
})

const USER = 'user-1'

beforeEach(async () => {
  await db.delete(schema.lifecycleSends)
  await db.delete(schema.auditLog)
  await db.delete(schema.notificationPreferences)
  await db.delete(schema.entitlements)
  await db.delete(schema.users)
  await db.insert(schema.users).values({
    id: USER,
    email: `${USER}@example.com`,
    name: 'Ada Lovelace',
  })
})

describe('deleteAccount with billing registered', () => {
  it('retains entitlements under the same user_id — the FK billing history keeps', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-1',
      userId: USER,
      paddleSubscriptionId: 'txn_abc',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    })

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    const entitlement = await db.query.entitlements.findFirst({
      where: eq(schema.entitlements.id, 'ent-1'),
    })
    expect(entitlement).toBeTruthy()
    expect(entitlement?.userId).toBe(USER)
    expect(entitlement?.status).toBe('active')
  })

  it('refuses when a live sub_ subscription exists, and changes nothing', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-live',
      userId: USER,
      paddleSubscriptionId: 'sub_live123',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    })

    const outcome = await deleteAccount(db, USER)
    expect(outcome).toEqual(blockedBySubscription('sub_live123'))

    // Untouched: no anonymization happened.
    const row = await db.query.users.findFirst({ where: eq(schema.users.id, USER) })
    expect(row?.email).toBe(`${USER}@example.com`)

    // No audit row either — the refusal happens before withAudit ever runs.
    expect(
      await db.query.auditLog.findMany({ where: eq(schema.auditLog.action, 'account.deleted') }),
    ).toHaveLength(0)
  })

  it.each(['past_due', 'paused'])(
    'blocks on a %s subscription, which still bills',
    async (status) => {
      // These two are the reason this guard keys on billing-liveness rather than
      // on ACTIVE_STATUSES. Neither grants access, so the access rule reads them
      // as dead — and both go on to charge a card: past_due when a dunning retry
      // succeeds, paused when the customer unpauses. Deleting here is the exact
      // outcome the guard exists to prevent, a renewal against an account nobody
      // can look up.
      await db.insert(schema.entitlements).values({
        id: `ent-${status}`,
        userId: USER,
        paddleSubscriptionId: `sub_${status}`,
        productKey: 'default',
        status,
        currentPeriodEnd: new Date(Date.now() - 1000),
      })

      expect(await deleteAccount(db, USER)).toEqual(blockedBySubscription(`sub_${status}`))
    },
  )

  it.each(['canceled', 'refunded', 'chargeback'])(
    'does not block on a %s subscription — nothing will ever bill it again',
    async (status) => {
      await db.insert(schema.entitlements).values({
        id: `ent-${status}`,
        userId: USER,
        paddleSubscriptionId: `sub_${status}`,
        productKey: 'default',
        status,
        currentPeriodEnd: new Date(Date.now() - 1000),
      })

      expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
    },
  )

  it('does not block on a comp or a pass, whatever their status', async () => {
    // Nothing renews these, so deleting simply forfeits the time left on them.
    await db.insert(schema.entitlements).values([
      {
        id: 'ent-comp',
        userId: USER,
        paddleSubscriptionId: 'comp_abc',
        productKey: 'default',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
      {
        id: 'ent-pass',
        userId: USER,
        paddleSubscriptionId: 'txn_abc',
        productKey: 'default',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    ])

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
  })

  it('checks for a live subscription across every product key, not just default', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-other-product',
      userId: USER,
      paddleSubscriptionId: 'sub_other_product',
      productKey: 'addon',
      status: 'trialing',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
    })

    const outcome = await deleteAccount(db, USER)
    expect(outcome).toEqual(blockedBySubscription('sub_other_product'))
  })
})

describe('exportAccount with billing registered', () => {
  it('adds the entitlements section, newest first, in the shape /privacy promises', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-1',
      userId: USER,
      paddleSubscriptionId: 'txn_abc',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
    })
    const result = await exportAccount(db, USER)
    expect(result?.entitlements).toEqual([
      {
        id: 'ent-1',
        paddleSubscriptionId: 'txn_abc',
        productKey: 'default',
        status: 'active',
        currentPeriodEnd: '2026-01-01T00:00:00.000Z',
        createdAt: expect.any(String),
      },
    ])
  })
})

// ── Billing-liveness, as a matrix ───────────────────────────────────────────
// Two surfaces used to answer "will this subscription charge somebody again"
// and they disagreed: the deletion guard said one thing, the "cancellable"
// count on /account said another. A past_due customer was shown nothing to
// cancel, handed a portal link with no subscription in it, and then refused
// deletion with "cancel it in the portal first" — pointing at the portal the
// page had just decided they had nothing to cancel in. These cases pin them
// together.

describe('billing liveness agrees across the deletion guard and the cancel count', () => {
  const CASES: { status: string; scheduled: string | null; live: boolean; why: string }[] = [
    { status: 'active', scheduled: null, live: true, why: 'the ordinary paying case' },
    { status: 'trialing', scheduled: null, live: true, why: 'a trial converts and charges' },
    { status: 'past_due', scheduled: null, live: true, why: 'a dunning retry can succeed' },
    { status: 'paused', scheduled: null, live: true, why: 'the customer can unpause' },
    {
      status: 'unknown',
      scheduled: null,
      live: true,
      why: 'an unrecognised status is not proof it is dead',
    },
    { status: 'canceled', scheduled: null, live: false, why: 'terminal' },
    { status: 'refunded', scheduled: null, live: false, why: 'terminal' },
    { status: 'chargeback', scheduled: null, live: false, why: 'terminal' },
    // The one Paddle does not express in `status` at all: it keeps a cancelled
    // subscription `active` for the whole notice period.
    { status: 'active', scheduled: 'cancel', live: false, why: 'cancel at period end' },
    { status: 'active', scheduled: 'pause', live: true, why: 'a pause still resumes and bills' },
    { status: 'active', scheduled: 'resume', live: true, why: 'obviously still billing' },
  ]

  it.each(CASES)('$status + scheduled=$scheduled → live=$live ($why)', async (testCase) => {
    await db.insert(schema.entitlements).values({
      id: 'ent-matrix',
      userId: USER,
      paddleSubscriptionId: 'sub_matrix',
      productKey: 'default',
      status: testCase.status,
      scheduledChangeAction: testCase.scheduled,
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
    })

    // Read the cancel count BEFORE deleting — deletion tombstones the row.
    const overview = await getBillingOverview(db, USER)
    expect(overview.cancellableSubscriptionIds.length > 0, 'cancellable count').toBe(testCase.live)

    const blocksDeletion = (await deleteAccount(db, USER)).outcome === 'blocked'
    expect(blocksDeletion, 'deletion guard').toBe(testCase.live)
  })
})
