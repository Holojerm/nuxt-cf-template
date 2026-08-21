// The audit trail, run against a real D1 inside workerd.
//
// The rule worth testing here is not "an insert inserts" — it is the policy in
// server/utils/audit.ts: the audit row is written BEFORE the privileged action,
// and a failed audit write means the action does not happen. That is a claim
// about ordering and about failure, and both are easy to regress in a way
// nothing else notices: swap the two lines in withAudit() and every happy-path
// test in this file still passes.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { listAudit, toAuditView, withAudit, writeAudit } from '../server/utils/audit'
import type { AuditDb } from '../server/utils/audit'

const db = drizzle(env.DB, { schema })

const ADMIN = 'admin-1'

/**
 * A db whose insert rejects. Cast through `unknown` rather than typed as `any`
 * — the point is to stand in for one method, not to switch off the checker.
 */
function failingDb(error: Error): AuditDb {
  return {
    insert: () => ({
      values: () => ({ returning: () => Promise.reject(error) }),
    }),
  } as unknown as AuditDb
}

/** A db whose insert silently succeeds without writing anything. */
function emptyInsertDb(): AuditDb {
  return {
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }),
  } as unknown as AuditDb
}

beforeEach(async () => {
  await db.delete(schema.auditLog)
})

describe('writeAudit', () => {
  it('records an action with the admin defaults', async () => {
    const row = await writeAudit(db, {
      actorUserId: ADMIN,
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: 'user-1',
    })

    expect(row.actorUserId).toBe(ADMIN)
    // Not null, and not guessed at read time: an ambiguous actor type makes the
    // row useless as evidence, which is why the column defaults rather than
    // allowing null.
    expect(row.actorType).toBe('admin')
    expect(row.action).toBe('admin.user_viewed')
    expect(row.targetId).toBe('user-1')
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('round-trips flat metadata through the JSON column', async () => {
    await writeAudit(db, {
      actorUserId: ADMIN,
      action: 'admin.pass_granted',
      targetType: 'user',
      targetId: 'user-1',
      metadata: { passes: 2, days: 60, reason: 'outage', previousEndsAt: null, stacked: true },
    })

    const [row] = await listAudit(db, { targetId: 'user-1' })
    expect(row?.metadata).toEqual({
      passes: 2,
      days: 60,
      reason: 'outage',
      previousEndsAt: null,
      stacked: true,
    })
  })

  it('records a system actor without a matching user row', async () => {
    // No foreign key on actor_user_id, on purpose — an automated action must be
    // recordable, and the record must outlive whoever performed it.
    const row = await writeAudit(db, {
      actorUserId: 'system',
      actorType: 'system',
      action: 'admin.pass_granted',
    })
    expect(row.actorType).toBe('system')
    expect(row.targetId).toBeNull()
  })

  it('throws when the insert writes nothing', async () => {
    // A no-op insert is indistinguishable from a recorded action, so it has to
    // fail like one rather than returning quietly.
    await expect(
      writeAudit(emptyInsertDb(), { actorUserId: ADMIN, action: 'admin.user_viewed' }),
    ).rejects.toThrow(/no row/)
  })
})

describe('withAudit — audit before act', () => {
  it('records the action, then runs it', async () => {
    const order: string[] = []

    const result = await withAudit(
      db,
      { actorUserId: ADMIN, action: 'admin.pass_granted', targetType: 'user', targetId: 'user-1' },
      async () => {
        // The row is already in the table by the time the action runs — that
        // ordering is the entire policy, so it is asserted from inside `act`.
        const rows = await listAudit(db, { targetId: 'user-1' })
        order.push(`act-sees-${rows.length}-rows`)
        return 'granted'
      },
    )

    expect(result).toBe('granted')
    expect(order).toEqual(['act-sees-1-rows'])
  })

  it('does NOT run the action when the audit write fails', async () => {
    let ran = false

    await expect(
      withAudit(
        failingDb(new Error('D1_ERROR: no such table')),
        { actorUserId: ADMIN, action: 'admin.pass_granted', targetId: 'user-1' },
        async () => {
          ran = true
          return 'granted'
        },
      ),
    ).rejects.toThrow(/D1_ERROR/)

    // An unrecorded privileged action is worse than a refused one. A refused
    // grant surfaces as an error the admin retries; an unrecorded one is an
    // entitlement in a customer's history that nothing can explain.
    expect(ran, 'the privileged action ran despite an unrecorded audit row').toBe(false)
  })

  it('propagates the action error without unwinding the audit row', async () => {
    let caught: unknown
    try {
      await withAudit(
        db,
        { actorUserId: ADMIN, action: 'admin.pass_granted', targetType: 'user', targetId: 'u-2' },
        async () => {
          throw new Error('grant blew up')
        },
      )
    } catch (error) {
      caught = error
    }
    expect((caught as Error | undefined)?.message).toBe('grant blew up')

    // Append-only means append-only: an attempt that failed halfway is exactly
    // the case you most want a record of, so nothing deletes it afterwards.
    const rows = await listAudit(db, { targetId: 'u-2' })
    expect(rows).toHaveLength(1)
  })
})

describe('listAudit', () => {
  beforeEach(async () => {
    await writeAudit(db, { actorUserId: ADMIN, action: 'admin.user_searched' })
    await writeAudit(db, {
      actorUserId: ADMIN,
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: 'user-a',
    })
    await writeAudit(db, {
      actorUserId: 'admin-2',
      action: 'admin.pass_granted',
      targetType: 'user',
      targetId: 'user-b',
    })
  })

  it('filters by actor', async () => {
    const rows = await listAudit(db, { actorUserId: ADMIN })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.actorUserId === ADMIN)).toBe(true)
  })

  it('filters by target', async () => {
    const rows = await listAudit(db, { targetType: 'user', targetId: 'user-b' })
    expect(rows.map((row) => row.action)).toEqual(['admin.pass_granted'])
  })

  it('caps the limit even when asked for more', async () => {
    const rows = await listAudit(db, { limit: 5000 })
    expect(rows.length).toBeLessThanOrEqual(200)
  })
})

describe('toAuditView', () => {
  it('serialises dates and withholds the ip hash', async () => {
    const row = await writeAudit(db, {
      actorUserId: ADMIN,
      action: 'admin.user_searched',
      metadata: { query: 'jane@example.com', limit: 20 },
      ipHash: 'a'.repeat(64),
    })

    const view = toAuditView(row)
    expect(view.createdAt).toBe(row.createdAt.toISOString())
    expect(view.metadata).toEqual({ query: 'jane@example.com', limit: 20 })
    // The hash is an investigation aid for someone with database access, not
    // something a browser needs — it must not appear on the wire.
    expect(Object.keys(view)).not.toContain('ipHash')
  })
})
