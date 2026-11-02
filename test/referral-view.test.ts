// The referral loop labels its own rows in the billing history: `referralKind`
// per row, from the ref's prefix, registered by server/plugins/referral.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildEntitlementView } from '#layers/billing/server/utils/entitlement-view'
import {
  clearEntitlementViewFieldsForTest,
  registerEntitlementViewFields,
} from '#layers/billing/server/utils/entitlement-view-fields'
import * as schema from '../server/db/schema'
import { referralHistoryFields } from '../server/utils/referral-view'

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

describe('referralKind on history rows', () => {
  it('names the side of the loop for referral rows and null for a purchase', async () => {
    registerEntitlementViewFields({ key: 'referral', history: referralHistoryFields })

    const view = await buildEntitlementView(db, USER)

    const kinds = Object.fromEntries(view.history.map((row) => [row.ref, row.referralKind]))
    expect(kinds).toEqual({ welcome_a: 'welcome', referral_b: 'reward', txn_c: null })
  })

  it('is absent until the plugin registers it', async () => {
    const view = await buildEntitlementView(db, USER)

    expect(view.history.every((row) => !('referralKind' in row))).toBe(true)
  })
})
