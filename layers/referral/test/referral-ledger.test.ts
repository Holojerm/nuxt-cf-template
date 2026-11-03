// The welcome ledger: a durable "this mailbox has spent its trial" record for an
// app whose account deletion removes entitlements. Default (nothing registered)
// behaviour is pinned in referral.test.ts; this is only the registered case.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import { clearExtensionsForTest } from '~~/server/utils/extensions'
import { registerEarnedAccess } from '~~/server/utils/earned-access'
import { billingEarnedAccess } from '#layers/billing/server/utils/billing-earned-access'
import { grantRefereeWelcome } from '../server/utils/referral'
import { clearWelcomeLedgerForTest, registerWelcomeLedger } from '../server/utils/referral-ledger'

const db = drizzle(env.DB, { schema })
const CODE = 'AB2CD3EF'
const REFEREE = { id: 'referee', email: 'referee@example.com', referredBy: CODE }

let spentRefs: Set<string>
let order: string[]
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  clearExtensionsForTest()
  registerEarnedAccess(billingEarnedAccess)
  spentRefs = new Set()
  order = []
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
  await db.insert(schema.users).values([
    { id: 'referrer', email: 'referrer@example.com', name: 'R', referralCode: CODE },
    { ...REFEREE, name: 'ref' },
  ])
})

afterEach(() => {
  clearWelcomeLedgerForTest()
  clearExtensionsForTest()
  vi.restoreAllMocks()
})

const ledger = () => ({
  spent: async (_db: unknown, ref: string) => {
    order.push('spent')
    return spentRefs.has(ref)
  },
  markSpent: async (_db: unknown, ref: string) => {
    order.push('mark')
    spentRefs.add(ref)
  },
})

describe('with a welcome ledger registered', () => {
  it('asks first, writes the days, then records the trial as spent', async () => {
    registerWelcomeLedger(ledger())

    const result = await grantRefereeWelcome(db, REFEREE)

    expect(result.outcome).toBe('granted')
    expect(order).toEqual(['spent', 'mark'])
    expect(spentRefs.size).toBe(1)
    expect([...spentRefs][0]).toMatch(/^welcome_[0-9a-f]+$/)
  })

  it('refuses a mailbox the ledger remembers, with no audit row and no days', async () => {
    registerWelcomeLedger(ledger())
    await grantRefereeWelcome(db, REFEREE)
    // The account is hard-deleted: its entitlements go with it, the ledger does not.
    await env.DB.exec('DELETE FROM entitlements')
    await env.DB.exec('DELETE FROM audit_log')

    const again = await grantRefereeWelcome(db, REFEREE)

    expect(again.outcome).toBe('already_granted')
    expect(await db.query.entitlements.findMany()).toEqual([])
    expect(await db.query.auditLog.findMany()).toEqual([])
  })

  it('does not record a trial that was not granted', async () => {
    registerWelcomeLedger(ledger())

    const result = await grantRefereeWelcome(db, { ...REFEREE, referredBy: 'ZZZZ2222' })

    expect(result.outcome).toBe('referrer_unresolved')
    expect(spentRefs.size).toBe(0)
    expect(order).toEqual(['spent'])
  })

  it('keeps the grant when recording it fails, and says so', async () => {
    registerWelcomeLedger({
      spent: async () => false,
      markSpent: async () => {
        throw new Error('ledger down')
      },
    })

    const result = await grantRefereeWelcome(db, REFEREE)

    expect(result.outcome).toBe('granted')
    expect(await db.query.entitlements.findMany()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"referral_welcome_mark_failed"'),
    )
  })

  it('fails the grant closed when the ledger cannot be read', async () => {
    registerWelcomeLedger({
      spent: async () => {
        throw new Error('ledger down')
      },
      markSpent: async () => {},
    })

    const result = await grantRefereeWelcome(db, REFEREE)

    expect(result.outcome).toBe('error')
    expect(await db.query.entitlements.findMany()).toEqual([])
  })
})

describe('with no ledger (the default)', () => {
  it('re-arms the trial for an app that hard-deletes entitlements, which is why the ledger exists', async () => {
    await grantRefereeWelcome(db, REFEREE)
    await env.DB.exec('DELETE FROM entitlements')

    expect((await grantRefereeWelcome(db, REFEREE)).outcome).toBe('granted')
  })
})
