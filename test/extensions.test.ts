// Core with no optional features registered — what a fork that drops the
// feedback layer, or billing, runs. Each consumer must still work and simply
// omit the feature's section. The feedback layer's own test covers it
// registering; billing's contributions are pinned by the suites that exercise
// them (account, fleet-status, fleet-funnel, purge, lifecycle, onboarding).

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { deleteAccount, exportAccount } from '../server/utils/account'
import { listAudit } from '../server/utils/audit'
import { requireAccess } from '../server/utils/access-gate'
import {
  clearExtensionsForTest,
  getAdminViewAsContributors,
  getRegisteredLifecycleSteps,
} from '../server/utils/extensions'
import { collectFleetCounters } from '../server/utils/fleet-status'
import { collectFleetFunnel } from '../server/utils/fleet-funnel'
import { computeOnboardingInputs } from '../server/utils/onboarding'

const db = drizzle(env.DB, { schema })
const USER = 'user-ext'

beforeAll(() => clearExtensionsForTest())

beforeEach(async () => {
  await db.delete(schema.auditLog)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER, email: 'ext@example.com', name: 'Ext' })
})

describe('core without feature contributors', () => {
  it('exports without a feedback section', async () => {
    const result = await exportAccount(db, USER)
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('feedback')
  })

  it('deletes, and the audit row carries no feedback count', async () => {
    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })
    const [row] = await listAudit(db, { targetType: 'user', targetId: USER, limit: 1 })
    expect(row?.metadata).not.toHaveProperty('feedbackCount')
  })

  it('reports fleet counters without a feedback group', async () => {
    expect(await collectFleetCounters(db)).not.toHaveProperty('feedback')
  })

  it('computes onboarding inputs without the feedback signal', async () => {
    expect(await computeOnboardingInputs(db, USER)).not.toHaveProperty('hasSentFeedback')
  })

  // A fork that never vendored billing: nothing guards deletion, so the
  // free-product behaviour is the plain delete the guard seam replaced.
  it('deletes an account that has a live-looking subscription row, unguarded', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'sub_live',
      status: 'active',
    })
    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })
    await db.delete(schema.entitlements)
  })

  it('exports without an entitlements section', async () => {
    expect(await exportAccount(db, USER)).not.toHaveProperty('entitlements')
  })

  it('reports no entitlements group and a paid funnel stage of 0', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER,
      paddleSubscriptionId: 'txn_1',
      status: 'active',
    })
    const counters = await collectFleetCounters(db)
    expect(counters).not.toHaveProperty('entitlements')
    expect(counters.funnel).toMatchObject({ paid: 0 })
    expect((await collectFleetFunnel(db)).paid).toBe(0)
    await db.delete(schema.entitlements)
  })

  it('contributes no onboarding entitlement signal, lifecycle step or view-as section', async () => {
    expect(await computeOnboardingInputs(db, USER)).not.toHaveProperty('entitlementActive')
    expect(getRegisteredLifecycleSteps()).toEqual([])
    expect(getAdminViewAsContributors()).toEqual([])
  })
})

// The paywall seam. With no gate registered a layer's routes (files) fall back
// to "signed in is enough" — the stand-in TEARDOWN.md documents. requireUserSession
// is nuxt-auth-utils' auto-import, which does not exist under vitest, so each
// case stubs it as the global the routes would resolve it to.
describe('requireAccess with no gate registered', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('allows a signed-in user and returns them', async () => {
    const user = { id: USER, email: 'ext@example.com' }
    vi.stubGlobal('requireUserSession', async () => ({ user }))
    expect(await requireAccess({} as never)).toEqual({ user })
  })

  it('refuses a signed-out caller the way requireUserSession does', async () => {
    vi.stubGlobal('requireUserSession', async () => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    })
    await expect(requireAccess({} as never)).rejects.toMatchObject({ statusCode: 401 })
  })
})
