// Billing's onboarding signal: the checklist's 'plan' step reads
// `entitlementActive`, which billing supplies from the entitlement view. Core's
// checklist, against a stand-in signal, is in test/onboarding-activation.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { clearExtensionsForTest } from '~~/server/utils/extensions'
import { computeOnboardingInputs } from '~~/server/utils/onboarding'
import { registerBillingExtensions } from '../server/utils/billing-extensions'

const db = drizzle(env.DB, { schema })
const USER_ID = 'user-billing-onboarding'

beforeEach(async () => {
  registerBillingExtensions()
  await db.delete(schema.entitlements)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER_ID, email: 'bo@example.com', name: 'Bo' })
})

afterEach(() => clearExtensionsForTest())

describe('onboarding signal from billing', () => {
  it('reads entitlementActive false for an account that bought nothing', async () => {
    expect(await computeOnboardingInputs(db, USER_ID)).toMatchObject({ entitlementActive: false })
  })

  it('reads entitlementActive from an active subscription row', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'active',
    })
    expect(await computeOnboardingInputs(db, USER_ID)).toMatchObject({ entitlementActive: true })
  })

  it('is not active for a past_due subscription: dunning grants no access', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'past_due',
    })
    expect(await computeOnboardingInputs(db, USER_ID)).toMatchObject({ entitlementActive: false })
  })
})
