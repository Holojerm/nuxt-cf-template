// What billing registers with core, driven through core's own entry points:
// the paywall gate (requireAccess → requireSubscription), the deletion guard
// (ordering and pass-through), and the registry bookkeeping. The consumers'
// behaviour with billing present or absent is pinned in account, fleet-status,
// fleet-funnel, purge, lifecycle and onboarding-activation, and in
// extensions.test.ts for core on its own.

import { env } from 'cloudflare:test'
import { createError } from 'h3'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { requireAccess } from '../server/utils/access-gate'
import { registerBillingExtensions } from '../server/utils/billing-extensions'
import {
  clearExtensionsForTest,
  getDeletionGuards,
  registerDeletionGuard,
} from '../server/utils/extensions'
import { deleteAccount } from '../server/utils/account'

const db = drizzle(env.DB, { schema })
const USER = 'user-billing-ext'

beforeEach(async () => {
  registerBillingExtensions()
  await db.delete(schema.auditLog)
  await db.delete(schema.entitlements)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'bx@example.com', name: 'Bx' })
  // Nitro auto-imports that do not exist under vitest.
  vi.stubGlobal('db', db)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('requireUserSession', async () => ({ user: { id: USER } }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearExtensionsForTest()
})

describe('requireAccess with billing registered', () => {
  it('refuses a signed-in user without an entitlement: 402 subscription_required', async () => {
    await expect(requireAccess({} as never)).rejects.toMatchObject({
      statusCode: 402,
      data: { code: 'subscription_required', productKey: 'default' },
    })
  })

  it('passes a user with an active subscription and returns the entitlement', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_gate',
      status: 'active',
    })
    const grant = await requireAccess({} as never)
    expect(grant.user).toEqual({ id: USER })
    expect(grant).toMatchObject({ entitlement: { paddleSubscriptionId: 'sub_gate' } })
  })

  it('passes the product key through to the gate', async () => {
    await expect(requireAccess({} as never, 'pro')).rejects.toMatchObject({
      data: { productKey: 'pro' },
    })
  })
})

describe('deletion guards', () => {
  it('registers billing’s guard under one key, and registering twice replaces it', () => {
    registerBillingExtensions()
    expect(getDeletionGuards().map((g) => g.key)).toEqual(['billing'])
  })

  it('lets a pass through (nothing renews it) and refuses a live subscription', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_pass',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    })
    const blocked = await getDeletionGuards()[0]!.check(db, USER)
    expect(blocked).toBeNull()

    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_renews',
      status: 'active',
    })
    expect(await getDeletionGuards()[0]!.check(db, USER)).toEqual({
      code: 'live_subscription',
      message: expect.stringContaining('billing portal'),
      data: { subscriptionId: 'sub_renews' },
    })
  })

  it('asks every guard, first refusal wins, and writes nothing when refused', async () => {
    registerDeletionGuard({
      key: 'second',
      check: async () => ({ code: 'second_says_no', message: 'No.' }),
    })
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_renews',
      status: 'active',
    })
    expect(await deleteAccount(db, USER)).toMatchObject({
      outcome: 'blocked',
      code: 'live_subscription',
    })

    clearExtensionsForTest()
    registerDeletionGuard({
      key: 'only',
      check: async () => ({ code: 'custom', message: 'Hold on.' }),
    })
    expect(await deleteAccount(db, USER)).toEqual({
      outcome: 'blocked',
      code: 'custom',
      message: 'Hold on.',
      data: {},
    })
    // Refused before the audit row: the account is untouched.
    const user = await db.query.users.findFirst()
    expect(user?.email).toBe('bx@example.com')
    expect(await db.query.auditLog.findMany()).toHaveLength(0)
  })
})
