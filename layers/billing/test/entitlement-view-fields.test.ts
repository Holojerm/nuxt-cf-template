// The view-field seam: what an app or another feature adds to the entitlement
// view, and the promise that nothing registered means nothing changed.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { buildEntitlementView } from '../server/utils/entitlement-view'
import {
  clearEntitlementViewFieldsForTest,
  registerEntitlementViewFields,
} from '../server/utils/entitlement-view-fields'

declare module '../server/utils/entitlement-view-fields' {
  interface EntitlementViewFields {
    seamTestPlan?: string
  }
  interface EntitlementHistoryFields {
    seamTestTag?: string
  }
}

const db = drizzle(env.DB, { schema })
const USER = 'user-fields'
const DAY = 86_400_000

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ id: USER, email: 'fields@example.com', name: 'Fields' })
  await db.insert(schema.entitlements).values([
    {
      userId: USER,
      paddleCustomerId: 'ctm_1',
      paddleSubscriptionId: 'sub_1',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
    },
    {
      userId: USER,
      paddleCustomerId: 'ctm_1',
      paddleSubscriptionId: 'txn_1',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() - 5 * DAY),
    },
  ])
})

afterEach(() => {
  clearEntitlementViewFieldsForTest()
  vi.restoreAllMocks()
})

describe('entitlement view fields', () => {
  it('leaves the view exactly as built when nothing is registered', async () => {
    const view = await buildEntitlementView(db, USER)

    expect(Object.keys(view)).toEqual([
      'active',
      'state',
      'status',
      'currentPeriodEnd',
      'kind',
      'comped',
      'referralKind',
      'cancelsAt',
      'cancellable',
      'portalAvailable',
      'history',
    ])
    for (const row of view.history) {
      expect(Object.keys(row)).toEqual([
        'ref',
        'kind',
        'comped',
        'referral',
        'status',
        'currentPeriodEnd',
        'purchasedAt',
      ])
    }
  })

  it('adds a registered field to the view and to every history row', async () => {
    const before = JSON.parse(JSON.stringify(await buildEntitlementView(db, USER)))
    registerEntitlementViewFields({
      key: 'test',
      view: ({ describing, userId }) => ({
        seamTestPlan: `${userId}:${describing?.paddleSubscriptionId ?? 'none'}`,
      }),
      history: (row) => ({ seamTestTag: row.paddleSubscriptionId.slice(0, 3) }),
    })

    const view = await buildEntitlementView(db, USER)

    expect(view.seamTestPlan).toBe(`${USER}:sub_1`)
    expect(view.history.map((row) => row.seamTestTag).toSorted()).toEqual(['sub', 'txn'])
    // Everything that was there is still there, in the same order, with the same values.
    const { seamTestPlan: _plan, history, ...rest } = JSON.parse(JSON.stringify(view))
    const { history: beforeHistory, ...beforeRest } = before
    expect(rest).toEqual(beforeRest)
    expect(Object.keys(rest)).toEqual(Object.keys(beforeRest))
    expect(history.map(({ seamTestTag: _tag, ...row }: Record<string, unknown>) => row)).toEqual(
      beforeHistory,
    )
  })

  it('re-registering a key replaces it rather than doubling it', async () => {
    registerEntitlementViewFields({ key: 'test', view: () => ({ seamTestPlan: 'first' }) })
    registerEntitlementViewFields({ key: 'test', view: () => ({ seamTestPlan: 'second' }) })

    expect((await buildEntitlementView(db, USER)).seamTestPlan).toBe('second')
  })

  it('never overwrites a field the view already has, and logs the attempt', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerEntitlementViewFields({
      key: 'greedy',
      view: () => ({ active: false, seamTestPlan: 'kept' }) as never,
      history: () => ({ status: 'hacked', seamTestTag: 'kept' }) as never,
    })

    const view = await buildEntitlementView(db, USER)

    expect(view.active).toBe(true)
    expect(view.seamTestPlan).toBe('kept')
    for (const row of view.history) {
      expect(row.status).toBe('active')
      expect(row.seamTestTag).toBe('kept')
    }
    const kinds = error.mock.calls.map((call) => JSON.parse(String(call[0])))
    expect(kinds).toContainEqual({
      kind: 'billing_view_field_collision',
      contributor: 'greedy',
      field: 'active',
    })
    expect(kinds).toContainEqual({
      kind: 'billing_view_field_collision',
      contributor: 'greedy',
      field: 'status',
    })
  })

  it('logs and skips a contributor that throws, keeping the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerEntitlementViewFields({
      key: 'broken',
      view: () => {
        throw new Error('boom')
      },
      history: () => {
        throw new Error('boom')
      },
    })
    registerEntitlementViewFields({ key: 'fine', view: () => ({ seamTestPlan: 'ok' }) })

    const view = await buildEntitlementView(db, USER)

    expect(view.active).toBe(true)
    expect(view.seamTestPlan).toBe('ok')
    expect(view.history).toHaveLength(2)
    const logged = error.mock.calls.map((call) => JSON.parse(String(call[0])))
    expect(logged.filter((l) => l.kind === 'billing_view_fields_failed')).toHaveLength(3)
  })

  it('lets a later contributor win a clash between contributors', async () => {
    registerEntitlementViewFields({ key: 'a', view: () => ({ seamTestPlan: 'a' }) })
    registerEntitlementViewFields({ key: 'b', view: () => ({ seamTestPlan: 'b' }) })

    expect((await buildEntitlementView(db, USER)).seamTestPlan).toBe('b')
  })
})
