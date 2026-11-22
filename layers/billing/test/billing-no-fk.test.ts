// An app whose `entitlements` table has no foreign key to `users` (an older
// schema it has not rebuilt) must still refuse to write an entitlement for an
// account that does not exist. The layer asks `users` itself before writing a
// new row, so the outcome does not depend on the table having the constraint.
// Here the table is recreated WITHOUT the key, in this file's own D1.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  applyBillingEvent,
  billingEventSchema,
  type BillingEvent,
} from '../server/utils/entitlements'
import { priceCatalogue } from '../server/utils/stripe-prices'

const db = drizzle(env.DB, { schema })
const KNOWN = 'user-known'
const CATALOGUE = priceCatalogue({ stripePriceMonthly: 'price_m', stripePricePass: 'price_p' })
let seq = 0

function event(type: string, data: Record<string, unknown>): BillingEvent {
  return billingEventSchema.parse({
    event_id: `evt_nofk_${++seq}`,
    event_type: type,
    occurred_at: new Date().toISOString(),
    data,
  })
}

const pass = (id: string, userId: string, priceId = 'price_p') =>
  event('transaction.completed', {
    id,
    status: 'completed',
    customer_id: 'cus_1',
    billed_at: new Date().toISOString(),
    custom_data: { userId },
    items: [{ price: { id: priceId } }],
  })

const subscription = (id: string, userId: string, status = 'active') =>
  event('subscription.created', {
    id,
    status,
    customer_id: 'cus_1',
    custom_data: { userId },
    items: [{ price: { id: 'price_m' } }],
    current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  })

beforeAll(async () => {
  // One statement per line: D1's exec runs a line at a time.
  await env.DB.exec('DROP TABLE entitlements')
  await env.DB.exec(
    "CREATE TABLE entitlements (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, provider_customer_id text, billing_ref text NOT NULL, product_key text DEFAULT 'default' NOT NULL, status text NOT NULL, current_period_end integer, period_start integer, scheduled_change_action text, scheduled_change_at integer, earned_from_ref text, restore_period_end integer, first_transaction_id text, last_event_at integer, created_at integer NOT NULL, updated_at integer NOT NULL)",
  )
  await env.DB.exec(
    'CREATE UNIQUE INDEX entitlements_billing_ref_unique ON entitlements (billing_ref)',
  )
  await env.DB.exec('CREATE INDEX entitlements_user_id_idx ON entitlements (user_id)')
})

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM billing_events')
  await db
    .insert(schema.users)
    .values({ id: KNOWN, email: 'known@example.com', name: 'Known' })
    .onConflictDoNothing()
})

describe('an entitlements table with no foreign key', () => {
  it('really accepts a row for nobody (the premise of this file)', async () => {
    await db.insert(schema.entitlements).values({
      userId: 'nobody',
      billingRef: 'pi_probe',
      status: 'active',
    })
    expect(await db.query.entitlements.findMany()).toHaveLength(1)
  })

  it('acknowledges a pass for an account that does not exist, and writes nothing', async () => {
    const outcome = await applyBillingEvent(db, pass('pi_1', 'nobody'), CATALOGUE)
    expect(outcome).toEqual({ kind: 'ignored', reason: 'unknown_user' })
    expect(await db.query.entitlements.findMany()).toHaveLength(0)
    expect(await db.query.billingEvents.findMany()).toHaveLength(0)
  })

  it('acknowledges a new subscription for an account that does not exist, and writes nothing', async () => {
    const outcome = await applyBillingEvent(db, subscription('sub_1', 'nobody'), CATALOGUE)
    expect(outcome).toEqual({ kind: 'ignored', reason: 'unknown_user' })
    expect(await db.query.entitlements.findMany()).toHaveLength(0)
  })

  it('still grants the account that exists', async () => {
    expect((await applyBillingEvent(db, pass('pi_2', KNOWN), CATALOGUE)).kind).toBe('pass')
    expect((await applyBillingEvent(db, subscription('sub_2', KNOWN), CATALOGUE)).kind).toBe(
      'subscription',
    )
    expect(await db.query.entitlements.findMany()).toHaveLength(2)
  })

  it('judges the price first: an unknown price is reported as such, whoever it names', async () => {
    const outcome = await applyBillingEvent(db, pass('pi_3', 'nobody', 'price_other'), CATALOGUE)
    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'unrecognised_price' })
  })
})
