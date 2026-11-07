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
  getDeletionGuards,
  getDeletionResolvers,
  registerDeletionGuard,
  registerDeletionResolver,
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
  it('has no deletion guard, so deletion goes straight through', async () => {
    expect(getDeletionGuards()).toEqual([])
    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })
  })

  it('has no deletion resolver either, so nothing runs before the delete', async () => {
    expect(getDeletionResolvers()).toEqual([])
  })

  it('exports without an entitlements section', async () => {
    expect(await exportAccount(db, USER)).not.toHaveProperty('entitlements')
  })

  it('reports no entitlements group and a paid funnel stage of 0', async () => {
    const counters = await collectFleetCounters(db)
    expect(counters).not.toHaveProperty('entitlements')
    expect(Object.keys(counters).sort()).toEqual(['extra', 'funnel', 'ops', 'users'])
    expect(counters.funnel).toMatchObject({ paid: 0 })
    expect((await collectFleetFunnel(db)).paid).toBe(0)
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

// The seam billing's cancel-on-deletion option uses (layers/billing). Core's
// side of the contract: when resolvers run, and what a refusal leaves behind.
describe('deletion resolvers', () => {
  afterEach(() => clearExtensionsForTest())

  it('runs after the guards, and not at all when a guard refuses', async () => {
    const order: string[] = []
    registerDeletionGuard({
      key: 'guard',
      check: async () => {
        order.push('guard')
        return { code: 'no', message: 'No.' }
      },
    })
    registerDeletionResolver({
      key: 'resolver',
      resolve: async () => {
        order.push('resolver')
        return null
      },
    })

    expect(await deleteAccount(db, USER)).toMatchObject({ outcome: 'blocked', code: 'no' })
    expect(order).toEqual(['guard'])
  })

  it('lets deletion go on when it returns null, before the audit row exists', async () => {
    let auditRowsSeen = -1
    registerDeletionResolver({
      key: 'resolver',
      resolve: async () => {
        auditRowsSeen = (await db.query.auditLog.findMany()).length
        return null
      },
    })

    expect(await deleteAccount(db, USER)).toEqual({ outcome: 'deleted' })
    expect(auditRowsSeen).toBe(0)
  })

  it('turns a returned block into the same blocked outcome, leaving the account untouched', async () => {
    registerDeletionResolver({
      key: 'resolver',
      resolve: async () => ({ code: 'cannot', message: 'Could not.', data: { why: 'x' } }),
    })

    expect(await deleteAccount(db, USER)).toEqual({
      outcome: 'blocked',
      code: 'cannot',
      message: 'Could not.',
      data: { why: 'x' },
    })
    expect((await db.query.users.findFirst())?.email).toBe('ext@example.com')
    expect(await db.query.auditLog.findMany()).toHaveLength(0)
  })

  it('first refusal wins, and later resolvers do not run', async () => {
    const ran: string[] = []
    registerDeletionResolver({
      key: 'a',
      resolve: async () => {
        ran.push('a')
        return { code: 'a_no', message: 'A.' }
      },
    })
    registerDeletionResolver({
      key: 'b',
      resolve: async () => {
        ran.push('b')
        return null
      },
    })

    expect(await deleteAccount(db, USER)).toMatchObject({ code: 'a_no' })
    expect(ran).toEqual(['a'])
  })

  it('hands the request context to every guard and resolver, and tolerates a caller with none', async () => {
    const seen: unknown[] = []
    registerDeletionGuard({
      key: 'guard',
      check: async (_db, _userId, context) => {
        seen.push(context)
        return null
      },
    })
    registerDeletionResolver({
      key: 'resolver',
      resolve: async (_db, _userId, context) => {
        seen.push(context)
        return null
      },
    })
    // An existing two-argument implementation keeps working: it just ignores it.
    registerDeletionResolver({ key: 'legacy', resolve: async (_db, _userId) => null })

    expect(await deleteAccount(db, USER, { ipHash: 'hashed-ip' })).toEqual({ outcome: 'deleted' })
    expect(seen).toEqual([{ ipHash: 'hashed-ip' }, { ipHash: 'hashed-ip' }])
  })

  it('passes an empty context when the caller has no request', async () => {
    let seen: unknown = 'unset'
    registerDeletionResolver({
      key: 'resolver',
      resolve: async (_db, _userId, context) => {
        seen = context
        return null
      },
    })

    await deleteAccount(db, USER)
    expect(seen).toEqual({})
  })

  it('is forgotten by clearExtensionsForTest', () => {
    registerDeletionResolver({ key: 'a', resolve: async () => null })
    clearExtensionsForTest()
    expect(getDeletionResolvers()).toEqual([])
  })
})
