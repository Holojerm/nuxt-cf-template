// The referral loop labels its own rows on the billing view: `referral` and
// `referralKind` per history row and `referralKind` for the row that describes
// the plan, all from the ref's prefix, registered by server/plugins/referral.ts.
// The billing view itself carries none of them.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildEntitlementView } from '#layers/billing/server/utils/entitlement-view'
import * as schema from '../server/db/schema'
import {
  clearEntitlementViewFieldsForTest,
  registerEntitlementViewFields,
} from '../server/utils/entitlement-view-fields'
import { referralHistoryFields, referralViewFields } from '../server/utils/referral-view'

const registerReferral = () =>
  registerEntitlementViewFields({
    key: 'referral',
    view: referralViewFields,
    history: referralHistoryFields,
  })

const db = drizzle(env.DB, { schema })
const USER = 'user-referral-view'
const DAY = 86_400_000

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values({ id: USER, email: 'rv@example.com', name: 'RV' })
  const row = (ref: string, days: number) => ({
    userId: USER,
    paddleCustomerId: 'ctm_1',
    paddleSubscriptionId: ref,
    productKey: 'default',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + days * DAY),
  })
  await db
    .insert(schema.entitlements)
    .values([row('welcome_a', 7), row('referral_b', 14), row('txn_c', 30)])
})

afterEach(() => clearEntitlementViewFieldsForTest())

describe('the referral fields on history rows', () => {
  it('name the side of the loop for referral rows and null for a purchase', async () => {
    registerReferral()

    const view = await buildEntitlementView(db, USER)

    const kinds = Object.fromEntries(view.history.map((row) => [row.ref, row.referralKind]))
    expect(kinds).toEqual({ welcome_a: 'welcome', referral_b: 'reward', txn_c: null })
    const flags = Object.fromEntries(view.history.map((row) => [row.ref, row.referral]))
    expect(flags).toEqual({ welcome_a: true, referral_b: true, txn_c: false })
  })

  it('are absent until the plugin registers them', async () => {
    const view = await buildEntitlementView(db, USER)

    expect(view.history.every((row) => !('referralKind' in row) && !('referral' in row))).toBe(true)
  })
})

describe('referralKind on the row that describes the plan', () => {
  it('is the kind of the describing row, and null when nothing describes', async () => {
    registerReferral()
    // Only the welcome grant is granting access: it is the row that describes.
    await env.DB.exec("DELETE FROM entitlements WHERE paddle_subscription_id <> 'welcome_a'")
    expect((await buildEntitlementView(db, USER)).referralKind).toBe('welcome')

    await env.DB.exec('DELETE FROM entitlements')
    expect((await buildEntitlementView(db, USER)).referralKind).toBeNull()
  })

  it('is absent until the plugin registers it', async () => {
    expect('referralKind' in (await buildEntitlementView(db, USER))).toBe(false)
  })
})
