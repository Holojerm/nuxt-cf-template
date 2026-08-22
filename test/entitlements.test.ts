// The money rules, run against a real D1 inside workerd.
//
// Everything here goes through applyPaddleEvent — the same function the webhook
// route calls after verifying the signature — so a passing suite means the
// actual purchase, stacking, and refund paths behave, not just their parts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { eq } from 'drizzle-orm'
import {
  applyPaddleEvent,
  findActiveEntitlement,
  getBillingOverview,
  isBillingLive,
  paddleEventSchema,
  type PaddleEvent,
} from '../server/utils/entitlements'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const USER = 'user-1'

/** D1 timestamp columns are epoch seconds — expectations round the same way. */
function atSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

async function makeUser(id = USER) {
  await db
    .insert(schema.users)
    .values({ id, email: `${id}@example.com`, name: id })
    .onConflictDoNothing()
}

/** Build + validate an event exactly as the webhook route would parse it. */
function paddleEvent(eventType: string, data: Record<string, unknown>): PaddleEvent {
  return paddleEventSchema.parse({
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    event_type: eventType,
    data,
  })
}

function passPurchase(transactionId: string, billedAt: Date, userId = USER) {
  return paddleEvent('transaction.completed', {
    id: transactionId,
    status: 'completed',
    customer_id: 'ctm_1',
    billed_at: billedAt.toISOString(),
    custom_data: { userId, productKey: 'default' },
  })
}

function refund(opts: {
  transactionId?: string
  subscriptionId?: string
  action?: string
  status?: string
  type?: string
  eventType?: string
}) {
  return paddleEvent(opts.eventType ?? 'adjustment.created', {
    id: 'adj_1',
    action: opts.action ?? 'refund',
    type: opts.type ?? 'full',
    status: opts.status ?? 'approved',
    transaction_id: opts.transactionId ?? null,
    subscription_id: opts.subscriptionId ?? null,
    customer_id: 'ctm_1',
  })
}

beforeEach(async () => {
  await db.delete(schema.entitlements)
  await makeUser()
})

describe('one-time pass', () => {
  it('grants 30 days from the billing date', async () => {
    const billedAt = new Date('2026-08-01T12:00:00Z')
    const outcome = await applyPaddleEvent(db, passPurchase('txn_1', billedAt))

    expect(outcome).toMatchObject({ kind: 'pass', granted: true, stackedOn: null })
    const active = await findActiveEntitlement(db, USER)
    expect(active?.status).toBe('active')
    expect(active?.currentPeriodEnd?.getTime()).toBe(atSecond(billedAt.getTime() + 30 * DAY_MS))
  })

  it('is idempotent across webhook redelivery', async () => {
    const billedAt = new Date(Date.now() - DAY_MS)
    const first = await applyPaddleEvent(db, passPurchase('txn_1', billedAt))
    const redelivered = await applyPaddleEvent(db, passPurchase('txn_1', billedAt))

    expect(first).toMatchObject({ kind: 'pass', granted: true })
    expect(redelivered).toMatchObject({ kind: 'pass', granted: false })
    if (first.kind !== 'pass' || redelivered.kind !== 'pass') throw new Error('wrong kind')
    // Same window, not 30 more days.
    expect(redelivered.endsAt.getTime()).toBe(first.endsAt.getTime())
    const rows = await db.query.entitlements.findMany()
    expect(rows).toHaveLength(1)
  })

  it('ignores a transaction with no userId in custom_data', async () => {
    const outcome = await applyPaddleEvent(
      db,
      paddleEvent('transaction.completed', { id: 'txn_x', status: 'completed' }),
    )
    expect(outcome).toEqual({ kind: 'ignored', reason: 'no_user' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('ignores a transaction that belongs to a subscription (renewal)', async () => {
    const outcome = await applyPaddleEvent(
      db,
      paddleEvent('transaction.completed', {
        id: 'txn_renewal',
        subscription_id: 'sub_1',
        custom_data: { userId: USER },
      }),
    )
    expect(outcome).toEqual({ kind: 'ignored', reason: 'subscription_transaction' })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('expires once the window passes', async () => {
    await applyPaddleEvent(db, passPurchase('txn_old', new Date(Date.now() - 40 * DAY_MS)))
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })
})

describe('stacking passes', () => {
  it('extends from the current expiry, not from the purchase date', async () => {
    const first = new Date(Date.now() - 10 * DAY_MS)
    const firstResult = await applyPaddleEvent(db, passPurchase('txn_1', first))
    if (firstResult.kind !== 'pass') throw new Error('wrong kind')

    const second = await applyPaddleEvent(db, passPurchase('txn_2', new Date()))
    if (second.kind !== 'pass') throw new Error('wrong kind')

    expect(second.stackedOn?.getTime()).toBe(firstResult.endsAt.getTime())
    expect(second.endsAt.getTime()).toBe(firstResult.endsAt.getTime() + 30 * DAY_MS)
    // The user now has ~50 days of runway, from two separate rows.
    const active = await findActiveEntitlement(db, USER)
    expect(active?.paddleSubscriptionId).toBe('txn_2')
  })

  it('starts fresh when the previous pass has already lapsed', async () => {
    await applyPaddleEvent(db, passPurchase('txn_1', new Date(Date.now() - 60 * DAY_MS)))
    const billedAt = new Date()
    const second = await applyPaddleEvent(db, passPurchase('txn_2', billedAt))

    expect(second).toMatchObject({ kind: 'pass', stackedOn: null })
    if (second.kind !== 'pass') throw new Error('wrong kind')
    // Whole seconds: that's the resolution D1 stores timestamps at.
    expect(second.endsAt.getTime()).toBe(atSecond(billedAt.getTime() + 30 * DAY_MS))
  })

  it('extends past a running subscription rather than shortening it', async () => {
    const renewsAt = new Date(Date.now() + 20 * DAY_MS)
    await applyPaddleEvent(
      db,
      paddleEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: renewsAt.toISOString() },
      }),
    )
    const pass = await applyPaddleEvent(db, passPurchase('txn_1', new Date()))
    if (pass.kind !== 'pass') throw new Error('wrong kind')
    expect(pass.endsAt.getTime()).toBe(atSecond(renewsAt.getTime() + 30 * DAY_MS))
  })
})

describe('subscriptions', () => {
  it('grants access and follows the status lifecycle', async () => {
    const endsAt = new Date(Date.now() + 20 * DAY_MS)
    await applyPaddleEvent(
      db,
      paddleEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        customer_id: 'ctm_1',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
    )
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()

    await applyPaddleEvent(
      db,
      paddleEvent('subscription.canceled', {
        id: 'sub_1',
        status: 'canceled',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: endsAt.toISOString() },
      }),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const rows = await db.query.entitlements.findMany()
    expect(rows).toHaveLength(1) // upsert, not a second row
  })
})

describe('refunds and chargebacks', () => {
  async function activePass(transactionId = 'txn_1') {
    await applyPaddleEvent(db, passPurchase(transactionId, new Date()))
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  }

  it('revokes access when a refund is approved', async () => {
    await activePass()
    const outcome = await applyPaddleEvent(db, refund({ transactionId: 'txn_1' }))

    expect(outcome).toMatchObject({
      kind: 'adjustment',
      action: 'refund',
      result: { outcome: 'revoked', userId: USER, paddleRef: 'txn_1' },
    })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('refunded')
    // The window is closed too, so the MCP worker's date-based SQL gate agrees.
    expect(row?.currentPeriodEnd!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('waits for approval before revoking a pending refund', async () => {
    await activePass()
    const outcome = await applyPaddleEvent(
      db,
      refund({ transactionId: 'txn_1', status: 'pending_approval' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'status_not_final' } })
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('revokes on the adjustment.updated that approves it', async () => {
    await activePass()
    await applyPaddleEvent(db, refund({ transactionId: 'txn_1', status: 'pending_approval' }))
    await applyPaddleEvent(
      db,
      refund({ transactionId: 'txn_1', status: 'approved', eventType: 'adjustment.updated' }),
    )
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('leaves access alone when a refund is rejected', async () => {
    await activePass()
    await applyPaddleEvent(db, refund({ transactionId: 'txn_1', status: 'rejected' }))
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('revokes a partial refund too — the stated policy', async () => {
    await activePass()
    await applyPaddleEvent(db, refund({ transactionId: 'txn_1', type: 'partial' }))
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('revokes immediately on a chargeback, before Paddle approves it', async () => {
    await activePass()
    await applyPaddleEvent(
      db,
      refund({ transactionId: 'txn_1', action: 'chargeback', status: 'pending_approval' }),
    )
    const row = await db.query.entitlements.findFirst()
    expect(row?.status).toBe('chargeback')
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('ignores credits and chargeback warnings', async () => {
    await activePass()
    for (const action of ['credit', 'chargeback_warning', 'credit_reverse']) {
      const outcome = await applyPaddleEvent(db, refund({ transactionId: 'txn_1', action }))
      expect(outcome).toMatchObject({ result: { outcome: 'action_not_revoking' } })
    }
    expect(await findActiveEntitlement(db, USER)).not.toBeNull()
  })

  it('matches a subscription refund by subscription id', async () => {
    await applyPaddleEvent(
      db,
      paddleEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: new Date(Date.now() + 20 * DAY_MS).toISOString() },
      }),
    )
    // Paddle sends the renewal's transaction id, which we never stored, plus
    // the subscription id, which we did.
    const outcome = await applyPaddleEvent(
      db,
      refund({ transactionId: 'txn_unknown', subscriptionId: 'sub_1' }),
    )
    expect(outcome).toMatchObject({ result: { outcome: 'revoked', paddleRef: 'sub_1' } })
    expect(await findActiveEntitlement(db, USER)).toBeNull()
  })

  it('only revokes the refunded pass, leaving a stacked one alone', async () => {
    await applyPaddleEvent(db, passPurchase('txn_1', new Date()))
    await applyPaddleEvent(db, passPurchase('txn_2', new Date()))
    await applyPaddleEvent(db, refund({ transactionId: 'txn_2' }))

    const active = await findActiveEntitlement(db, USER)
    expect(active?.paddleSubscriptionId).toBe('txn_1')
  })

  it('acknowledges a refund with no matching entitlement', async () => {
    const outcome = await applyPaddleEvent(db, refund({ transactionId: 'txn_nope' }))
    expect(outcome).toMatchObject({ result: { outcome: 'no_matching_entitlement' } })
  })
})

describe('billing overview', () => {
  it('reports what can be cancelled and keeps ended rows in history', async () => {
    await applyPaddleEvent(db, passPurchase('txn_old', new Date(Date.now() - 60 * DAY_MS)))
    await applyPaddleEvent(
      db,
      paddleEvent('subscription.created', {
        id: 'sub_1',
        status: 'active',
        customer_id: 'ctm_9',
        custom_data: { userId: USER },
        current_billing_period: { ends_at: new Date(Date.now() + 10 * DAY_MS).toISOString() },
      }),
    )

    const overview = await getBillingOverview(db, USER)
    expect(overview.cancellableSubscriptionIds).toEqual(['sub_1'])
    expect(overview.paddleCustomerId).toBe('ctm_9')
    expect(overview.history).toHaveLength(2)
    expect(overview.active?.paddleSubscriptionId).toBe('sub_1')
  })

  it('has nothing to cancel for a pass-only customer', async () => {
    await applyPaddleEvent(db, passPurchase('txn_1', new Date()))
    const overview = await getBillingOverview(db, USER)
    expect(overview.cancellableSubscriptionIds).toEqual([])
  })
})

// ── Paddle's scheduled_change ───────────────────────────────────────────────
// "Cancel at period end" does not change a subscription's status. Paddle keeps
// it `active` and hangs `scheduled_change` off the entity until the effective
// date, so a row that will never be billed again is indistinguishable from one
// that renews next month unless this is stored. Not storing it meant the
// deletion guard refused, for up to a year, to delete an account whose
// subscription was already cancelled — and told the customer to go cancel it.
//
// Payloads below are shaped like the real thing (developer.paddle.com), because
// the field this is about is one `paddleEventSchema` used to strip silently.

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt_1',
    event_type: 'subscription.updated',
    data: {
      id: 'sub_sched',
      status: 'active',
      customer_id: 'ctm_1',
      custom_data: { userId: USER },
      current_billing_period: { ends_at: '2026-09-01T00:00:00Z' },
      ...overrides,
    },
  }
}

describe('scheduled_change', () => {
  async function subscriptionRow() {
    return db.query.entitlements.findFirst({
      where: eq(schema.entitlements.paddleSubscriptionId, 'sub_sched'),
    })
  }

  it('stores a pending cancel with its effective date', async () => {
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row?.status).toBe('active')
    expect(row?.scheduledChangeAction).toBe('cancel')
    expect(row?.scheduledChangeAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('makes a pending cancel not billing-live, though its status still says active', async () => {
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row!.status).toBe('active')
    expect(isBillingLive(row!)).toBe(false)
  })

  it('CLEARS it when Paddle sends scheduled_change: null — the un-cancel case', async () => {
    // The case that makes `?? null` load-bearing rather than stylistic. Every
    // subscription.* event carries the full entity, so an explicit null means
    // the customer withdrew the cancellation. Skipping the column on update
    // would leave a live subscription looking dead forever, blocking deletion
    // and telling /account it ends on a date that will never come.
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )
    expect((await subscriptionRow())?.scheduledChangeAction).toBe('cancel')

    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(subscriptionEvent({ scheduled_change: null })),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBeNull()
    expect(row?.scheduledChangeAt).toBeNull()
    expect(isBillingLive(row!)).toBe(true)
  })

  it('clears it when the field is absent entirely, not just explicitly null', async () => {
    // Paddle omits the key rather than nulling it in some payloads; absent and
    // null have to mean the same thing here.
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(
        subscriptionEvent({ scheduled_change: { action: 'cancel', effective_at: null } }),
      ),
    )
    await applyPaddleEvent(db, paddleEventSchema.parse(subscriptionEvent()))

    expect((await subscriptionRow())?.scheduledChangeAction).toBeNull()
  })

  it('keeps a pause scheduled without calling the subscription dead', async () => {
    // A pause resumes and bills again; only a cancel ends the money.
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(
        subscriptionEvent({
          scheduled_change: { action: 'pause', effective_at: '2026-09-01T00:00:00Z' },
        }),
      ),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBe('pause')
    expect(isBillingLive(row!)).toBe(true)
  })

  it('tolerates a cancel with no effective date', async () => {
    await applyPaddleEvent(
      db,
      paddleEventSchema.parse(subscriptionEvent({ scheduled_change: { action: 'cancel' } })),
    )

    const row = await subscriptionRow()
    expect(row?.scheduledChangeAction).toBe('cancel')
    expect(row?.scheduledChangeAt).toBeNull()
    expect(isBillingLive(row!)).toBe(false)
  })
})
