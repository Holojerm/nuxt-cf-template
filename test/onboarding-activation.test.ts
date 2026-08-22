// server/utils/onboarding.ts, run against a real D1 inside workerd.
//
// The rule worth testing here is not "the query returns rows" — it's the
// idempotency claim in recordActivationOnce(): `user_activated` fires the
// first time the checklist is observed complete, and never again for the
// same account, no matter how many more times GET /api/onboarding is called
// after that (which happens constantly in practice — every dashboard visit
// re-derives the checklist). That's easy to regress in a way a single
// happy-path call wouldn't catch: check the audit row after writing it
// instead of before, and every test here still passes on the first call.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../server/db/schema'
import { listAudit } from '../server/utils/audit'
import {
  activateIfComplete,
  computeOnboardingInputs,
  recordActivationOnce,
} from '../server/utils/onboarding'

const db = drizzle(env.DB, { schema })

const USER_ID = 'user-onboarding-1'

beforeEach(async () => {
  await db.delete(schema.auditLog)
  await db.delete(schema.feedback)
  await db.delete(schema.mcpConnectCodes)
  await db.delete(schema.notificationPreferences)
  await db.delete(schema.entitlements)
  await db.delete(schema.users)
  await db.insert(schema.users).values({ id: USER_ID, email: 'ada@example.com', name: 'Ada' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub the two globals captureServerEvent reaches for, so a call to it in
 * these tests neither hits the network nor throws for lack of Nitro. */
function stubPosthog(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { posthogKey: 'phc_test', posthogHost: 'https://us.i.posthog.com' },
  }))
  return fetchMock
}

describe('recordActivationOnce', () => {
  it('fires user_activated and writes the audit guard on the first call', async () => {
    const fetchMock = stubPosthog()

    const fired = await recordActivationOnce(db, USER_ID, 'control')

    expect(fired).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.event).toBe('user_activated')
    expect(body.distinct_id).toBe(USER_ID)
    expect(body.properties.onboarding_layout_variant).toBe('control')

    const rows = await listAudit(db, { targetId: USER_ID })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorUserId: USER_ID,
      actorType: 'user',
      action: 'onboarding.activated',
      targetType: 'user',
      targetId: USER_ID,
    })
  })

  it('does NOT fire again on a second call for the same account', async () => {
    const fetchMock = stubPosthog()

    const firstCall = await recordActivationOnce(db, USER_ID, 'control')
    const secondCall = await recordActivationOnce(db, USER_ID, 'control')

    expect(firstCall).toBe(true)
    expect(secondCall).toBe(false)
    // Only the first call's capture attempt hit the network.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const rows = await listAudit(db, { targetId: USER_ID })
    expect(rows).toHaveLength(1)
  })

  it('stays a no-op across many repeat calls — the realistic case is dozens of dashboard visits', async () => {
    const fetchMock = stubPosthog()

    for (let visit = 0; visit < 10; visit++) {
      await recordActivationOnce(db, USER_ID, 'control')
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(1)
  })

  it('tracks activation per account — a second user still fires their own event', async () => {
    const fetchMock = stubPosthog()
    const OTHER_USER = 'user-onboarding-2'
    await db.insert(schema.users).values({ id: OTHER_USER, email: 'bea@example.com', name: 'Bea' })

    await recordActivationOnce(db, USER_ID, 'control')
    const secondUserFired = await recordActivationOnce(db, OTHER_USER, 'compact')

    expect(secondUserFired).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(1)
    expect(await listAudit(db, { targetId: OTHER_USER })).toHaveLength(1)
  })

  it('records the audit row even when the PostHog capture attempt fails — the guard must not depend on delivery', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { posthogKey: 'phc_test', posthogHost: 'https://us.i.posthog.com' },
    }))

    // captureServerEvent (server/utils/posthog.ts) swallows its own network
    // errors and never throws, so this resolves normally either way.
    const fired = await recordActivationOnce(db, USER_ID, 'control')

    expect(fired).toBe(true)
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(1)

    // A later call still sees the guard and stays a no-op, even though the
    // capture itself never actually reached PostHog.
    const secondCall = await recordActivationOnce(db, USER_ID, 'control')
    expect(secondCall).toBe(false)
  })
})

describe('computeOnboardingInputs', () => {
  it('reads false/absent for every signal on a freshly created account', async () => {
    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs).toEqual({
      entitlementActive: false,
      hasNotificationPreference: false,
      hasConnectedClient: false,
      hasSentFeedback: false,
    })
  })

  it('counts a minted-but-unredeemed MCP connect code as NOT connected', async () => {
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      // usedAt intentionally left null — minted, not redeemed.
    })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs.hasConnectedClient).toBe(false)
  })

  it('counts a redeemed MCP connect code as connected', async () => {
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs.hasConnectedClient).toBe(true)
  })

  it('counts any saved notification preference row, whatever its value', async () => {
    await db.insert(schema.notificationPreferences).values({
      userId: USER_ID,
      channel: 'email',
      eventType: 'product_updates',
      enabled: false,
    })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs.hasNotificationPreference).toBe(true)
  })

  it('counts any feedback row for this user as sent', async () => {
    await db
      .insert(schema.feedback)
      .values({ userId: USER_ID, kind: 'idea', message: 'Add dark mode' })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs.hasSentFeedback).toBe(true)
  })

  it('reads entitlementActive from an active subscription row', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'active',
    })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs.entitlementActive).toBe(true)
  })

  // GET /api/onboarding calls nothing but this function — no
  // recordActivationOnce, no audit write. That used to not be true (see the
  // header comment on server/utils/onboarding.ts), and the regression it
  // caused was invisible to every other test in this file, which all drive
  // recordActivationOnce/activateIfComplete directly rather than through a
  // read path. This is the one that would have caught it: seed every signal
  // true, call only the read function, and prove nothing landed in
  // audit_log regardless.
  it('never writes an audit row, even for an already-complete account', async () => {
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'active',
    })
    await db.insert(schema.notificationPreferences).values({
      userId: USER_ID,
      channel: 'email',
      eventType: 'product_updates',
      enabled: true,
    })
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'd'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })
    await db.insert(schema.feedback).values({ userId: USER_ID, kind: 'idea', message: 'Read-only' })

    const inputs = await computeOnboardingInputs(db, USER_ID, { portalConfigured: false })
    expect(inputs).toEqual({
      entitlementActive: true,
      hasNotificationPreference: true,
      hasConnectedClient: true,
      hasSentFeedback: true,
    })

    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(0)
  })
})

describe('activateIfComplete', () => {
  it('writes nothing and reports not activated when the checklist is incomplete', async () => {
    const fetchMock = stubPosthog()

    const result = await activateIfComplete(db, USER_ID, 'control', { portalConfigured: false })

    expect(result).toEqual({ activated: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(0)
  })

  it('does not trust a caller into activating a still-incomplete account — it recomputes and finds the same gap', async () => {
    // Three of four signals true; entitlementActive still false. There's no
    // "trust me, it's done" input to this function at all — the only way to
    // make it return activated:true is to actually seed the fourth signal,
    // which is the point: recomputing from D1, not from what the caller
    // (POST /api/onboarding/activated) claims, is what makes this endpoint
    // safe to call with a client-asserted variant but nothing else.
    await db.insert(schema.notificationPreferences).values({
      userId: USER_ID,
      channel: 'email',
      eventType: 'product_updates',
      enabled: true,
    })
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'e'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })
    await db.insert(schema.feedback).values({ userId: USER_ID, kind: 'idea', message: 'Almost' })

    const result = await activateIfComplete(db, USER_ID, 'control', { portalConfigured: false })

    expect(result).toEqual({ activated: false })
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(0)
  })

  it('activates once a complete account is seeded, and records the variant passed in', async () => {
    const fetchMock = stubPosthog()
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'active',
    })
    await db.insert(schema.notificationPreferences).values({
      userId: USER_ID,
      channel: 'email',
      eventType: 'product_updates',
      enabled: true,
    })
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'f'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })
    await db.insert(schema.feedback).values({ userId: USER_ID, kind: 'idea', message: 'Done' })

    const result = await activateIfComplete(db, USER_ID, 'compact', { portalConfigured: false })

    expect(result).toEqual({ activated: true })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string)
    // The recorded variant is the one this call was given — not a stale
    // fallback from an earlier, differently-timed call (the bug this whole
    // POST endpoint exists to fix).
    expect(body.properties.onboarding_layout_variant).toBe('compact')

    const rows = await listAudit(db, { targetId: USER_ID })
    expect(rows).toHaveLength(1)
  })

  it('is idempotent through the same path a repeat POST would take', async () => {
    const fetchMock = stubPosthog()
    await db.insert(schema.entitlements).values({
      userId: USER_ID,
      paddleSubscriptionId: 'sub_1',
      status: 'active',
    })
    await db.insert(schema.notificationPreferences).values({
      userId: USER_ID,
      channel: 'email',
      eventType: 'product_updates',
      enabled: true,
    })
    await db.insert(schema.mcpConnectCodes).values({
      userId: USER_ID,
      codeHash: 'a1'.repeat(32),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })
    await db.insert(schema.feedback).values({ userId: USER_ID, kind: 'idea', message: 'Done' })

    const first = await activateIfComplete(db, USER_ID, 'control', { portalConfigured: false })
    // A second POST — e.g. the client's onMounted trigger and its
    // variant-change watcher both firing — must not double-record, even
    // with a DIFFERENT variant on the second call.
    const second = await activateIfComplete(db, USER_ID, 'compact', { portalConfigured: false })

    expect(first).toEqual({ activated: true })
    expect(second).toEqual({ activated: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listAudit(db, { targetId: USER_ID })).toHaveLength(1)
  })
})
