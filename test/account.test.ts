// Self-serve account deletion and export, run against a real D1 inside
// workerd. Three things have to hold, and each has a way of failing silently:
//
//   1. Deletion anonymizes the `users` row rather than erasing it — the id has
//      to survive so entitlements (a real foreign key) don't orphan or block.
//   2. A live `sub_…` subscription refuses the whole thing, before anything is
//      touched — the one guard this feature adds, because Paddle keeps
//      charging a deleted account otherwise.
//   3. The export never leaks more than it says it does: no admin identity on
//      an audit entry, no other person's referral attribution on the user
//      object, nothing from a different account's audit trail.

import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { deleteAccount, exportAccount } from '../server/utils/account'

const db = drizzle(env.DB, { schema })

const USER = 'user-1'
const OTHER = 'user-2'

beforeEach(async () => {
  await db.delete(schema.auditLog)
  await db.delete(schema.feedback)
  await db.delete(schema.notificationPreferences)
  await db.delete(schema.files)
  await db.delete(schema.mcpConnectCodes)
  await db.delete(schema.entitlements)
  await db.delete(schema.users)

  await db.insert(schema.users).values({
    id: USER,
    email: `${USER}@example.com`,
    name: 'Ada Lovelace',
    avatarUrl: 'https://example.com/avatar.png',
    provider: 'github',
    signupSource: 'twitter',
    signupMedium: 'social',
    signupCampaign: 'launch',
    signupReferrer: 'https://twitter.com',
    referralCode: 'ABC12345',
    // Another person's attribution — deleting THIS account must not erase it.
    referredBy: 'XYZ99999',
  })
})

describe('deleteAccount', () => {
  it('reports not_found for a missing user, without touching anything else', async () => {
    expect(await deleteAccount(db, 'ghost')).toEqual({ outcome: 'not_found' })
  })

  it('anonymizes every PII column on the users row but leaves referred_by alone', async () => {
    const outcome = await deleteAccount(db, USER)
    expect(outcome.outcome).toBe('deleted')

    const row = await db.query.users.findFirst({ where: eq(schema.users.id, USER) })
    expect(row?.email).toBe(`deleted-${USER}@deleted.invalid`)
    expect(row?.name).toBe('Deleted user')
    expect(row?.avatarUrl).toBeNull()
    expect(row?.provider).toBeNull()
    expect(row?.signupSource).toBeNull()
    expect(row?.signupMedium).toBeNull()
    expect(row?.signupCampaign).toBeNull()
    expect(row?.signupReferrer).toBeNull()
    expect(row?.referralCode).toBeNull()
    // Not this account's to erase — it names where somebody ELSE's signup
    // came from.
    expect(row?.referredBy).toBe('XYZ99999')
  })

  it('retains entitlements under the same user_id — the FK billing history keeps', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-1',
      userId: USER,
      paddleSubscriptionId: 'txn_abc',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    })

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    const entitlement = await db.query.entitlements.findFirst({
      where: eq(schema.entitlements.id, 'ent-1'),
    })
    expect(entitlement).toBeTruthy()
    expect(entitlement?.userId).toBe(USER)
    expect(entitlement?.status).toBe('active')
  })

  it('hard-deletes files, mcp connect codes, and notification preferences', async () => {
    await db.insert(schema.files).values({
      id: 'file-1',
      userId: USER,
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      r2Key: `uploads/${USER}/a.png`,
      status: 'uploaded',
    })
    await db.insert(schema.mcpConnectCodes).values({
      id: 'code-1',
      userId: USER,
      codeHash: 'hash-value',
      expiresAt: new Date(Date.now() + 60_000),
    })
    await db.insert(schema.notificationPreferences).values({
      id: 'pref-1',
      userId: USER,
      channel: 'email',
      eventType: 'payment_failed',
      enabled: false,
    })

    const outcome = await deleteAccount(db, USER)
    expect(outcome).toMatchObject({
      outcome: 'deleted',
      counts: { filesDeleted: 1, connectCodesDeleted: 1, notificationPreferencesDeleted: 1 },
    })

    expect(await db.query.files.findMany({ where: eq(schema.files.userId, USER) })).toHaveLength(0)
    expect(
      await db.query.mcpConnectCodes.findMany({ where: eq(schema.mcpConnectCodes.userId, USER) }),
    ).toHaveLength(0)
    expect(
      await db.query.notificationPreferences.findMany({
        where: eq(schema.notificationPreferences.userId, USER),
      }),
    ).toHaveLength(0)
  })

  it('scrubs PII off a feedback row but keeps the message itself', async () => {
    await db.insert(schema.feedback).values({
      id: 'fb-1',
      userId: USER,
      kind: 'bug',
      message: 'The export button did nothing on Safari',
      email: 'ada@example.com',
      userAgent: 'Mozilla/5.0',
      ipHash: 'abc123',
    })

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')

    const row = await db.query.feedback.findFirst({ where: eq(schema.feedback.id, 'fb-1') })
    expect(row?.message).toBe('The export button did nothing on Safari')
    expect(row?.email).toBeNull()
    expect(row?.userAgent).toBeNull()
    expect(row?.ipHash).toBeNull()
    // Never a foreign key (schema.ts) — left pointing at the now-anonymized
    // account rather than nulled, so "how many people gave feedback" survives.
    expect(row?.userId).toBe(USER)
  })

  it('writes an account.deleted audit row, actor and target both the deleting user', async () => {
    await db.insert(schema.files).values({
      id: 'file-1',
      userId: USER,
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      r2Key: `uploads/${USER}/a.png`,
      status: 'uploaded',
    })

    await deleteAccount(db, USER)

    const rows = await db.query.auditLog.findMany({
      where: and(eq(schema.auditLog.actorUserId, USER), eq(schema.auditLog.action, 'account.deleted')),
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.actorType).toBe('user')
    expect(row.targetType).toBe('user')
    expect(row.targetId).toBe(USER)
    // Counts only — never PII (see server/utils/audit.ts policy note).
    expect(row.metadata).toMatchObject({
      filesCount: 1,
      connectCodesCount: 0,
      notificationPreferencesCount: 0,
      feedbackCount: 0,
    })
  })

  it('refuses when a live sub_ subscription exists, and changes nothing', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-live',
      userId: USER,
      paddleSubscriptionId: 'sub_live123',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    })

    const outcome = await deleteAccount(db, USER)
    expect(outcome).toEqual({ outcome: 'live_subscription', subscriptionId: 'sub_live123' })

    // Untouched: no anonymization happened.
    const row = await db.query.users.findFirst({ where: eq(schema.users.id, USER) })
    expect(row?.email).toBe(`${USER}@example.com`)

    // No audit row either — the refusal happens before withAudit ever runs.
    expect(
      await db.query.auditLog.findMany({ where: eq(schema.auditLog.action, 'account.deleted') }),
    ).toHaveLength(0)
  })

  it('does not block on a past_due subscription or a comp/pass', async () => {
    await db.insert(schema.entitlements).values([
      {
        id: 'ent-past-due',
        userId: USER,
        paddleSubscriptionId: 'sub_expired',
        productKey: 'default',
        status: 'past_due',
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
      {
        id: 'ent-comp',
        userId: USER,
        paddleSubscriptionId: 'comp_abc',
        productKey: 'default',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    ])

    expect((await deleteAccount(db, USER)).outcome).toBe('deleted')
  })

  it('checks for a live subscription across every product key, not just default', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-other-product',
      userId: USER,
      paddleSubscriptionId: 'sub_other_product',
      productKey: 'addon',
      status: 'trialing',
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24),
    })

    const outcome = await deleteAccount(db, USER)
    expect(outcome).toEqual({ outcome: 'live_subscription', subscriptionId: 'sub_other_product' })
  })
})

describe('exportAccount', () => {
  it('returns null for a missing user', async () => {
    expect(await exportAccount(db, 'ghost')).toBeNull()
  })

  it('shapes the export and never leaks more than it says', async () => {
    await db.insert(schema.entitlements).values({
      id: 'ent-1',
      userId: USER,
      paddleSubscriptionId: 'txn_abc',
      productKey: 'default',
      status: 'active',
      currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
    })
    await db.insert(schema.feedback).values({
      id: 'fb-1',
      userId: USER,
      kind: 'idea',
      message: 'Add dark mode',
      status: 'new',
      email: 'ada@example.com',
      repliedBy: 'admin-1',
    })
    // Only one optional type is overridden — the export should still report
    // the EFFECTIVE state of every optional type, not just the rows that
    // happen to exist (see AccountExportNotificationPreference).
    await db.insert(schema.notificationPreferences).values({
      id: 'pref-1',
      userId: USER,
      channel: 'email',
      eventType: 'product_updates',
      enabled: false,
    })
    // Targets this user — belongs in the export.
    await db.insert(schema.auditLog).values({
      id: 'audit-1',
      actorUserId: 'admin-1',
      actorType: 'admin',
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: USER,
    })
    // Targets a DIFFERENT user — must not leak into this export.
    await db.insert(schema.auditLog).values({
      id: 'audit-2',
      actorUserId: 'admin-1',
      actorType: 'admin',
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: OTHER,
    })

    const result = await exportAccount(db, USER)
    expect(result).toBeTruthy()
    if (!result) return

    expect(result.user).toMatchObject({
      id: USER,
      email: `${USER}@example.com`,
      name: 'Ada Lovelace',
      referralCode: 'ABC12345',
    })
    // Someone else's attribution, not this export owner's data.
    expect(result.user).not.toHaveProperty('referredBy')

    expect(result.entitlements).toHaveLength(1)
    expect(result.entitlements[0]).toMatchObject({ id: 'ent-1', status: 'active' })

    expect(result.feedback).toHaveLength(1)
    expect(result.feedback[0]).toMatchObject({ id: 'fb-1', message: 'Add dark mode' })
    expect(result.feedback[0]).not.toHaveProperty('email')
    expect(result.feedback[0]).not.toHaveProperty('repliedBy')
    expect(result.feedback[0]).not.toHaveProperty('ipHash')

    // Every optional type appears — welcome/referral default-on since neither
    // was ever toggled, product_updates reflects the row above.
    expect(result.notificationPreferences).toEqual([
      { eventType: 'welcome', enabled: true },
      { eventType: 'product_updates', enabled: false },
      { eventType: 'referral', enabled: true },
    ])

    // Only the row that targets THIS user — and never who did it.
    expect(result.auditEntries).toEqual([
      { action: 'admin.user_viewed', actorType: 'admin', createdAt: expect.any(String) },
    ])
    expect(result.auditEntries[0]).not.toHaveProperty('actorUserId')

    expect(typeof result.exportedAt).toBe('string')
  })
})
