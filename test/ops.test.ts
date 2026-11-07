// The ops spool, run against a real D1 inside workerd: writers never throw,
// the unauthenticated writer is throttled, retention prunes by age. The
// per-kind summary the fleet dashboard reads is tested in test/fleet-status.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  OPS_EVENT_RETENTION_DAYS,
  pruneOpsEvents,
  recentOpsEvents,
  recordOpsEvent,
  recordUnauthenticatedOpsEvent,
  resetUnauthenticatedOpsThrottleForTest,
  UNAUTHENTICATED_OPS_INTERVAL_MS,
} from '../server/utils/ops'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-21T12:00:00.000Z')

async function spool(kind: string, count: number, at = NOW) {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.opsEvents).values({
      kind,
      detail: `${kind} #${i}`,
      path: `/api/thing/${i}`,
      createdAt: at,
      updatedAt: at,
    })
  }
}

beforeEach(async () => {
  await db.delete(schema.opsEvents)
})

describe('pruneOpsEvents', () => {
  it('deletes only rows past retention', async () => {
    const old = new Date(NOW.getTime() - (OPS_EVENT_RETENTION_DAYS + 1) * DAY_MS)
    await spool('server_error', 2, old)
    await spool('server_error', 1, NOW)

    expect(await pruneOpsEvents(db, NOW)).toBe(2)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(1)
    expect(await pruneOpsEvents(db, NOW)).toBe(0)
  })
})

describe('recordOpsEvent', () => {
  it('writes a row', async () => {
    await recordOpsEvent(db, { kind: 'server_error', detail: '500 boom', path: '/api/x' })
    const rows = await db.select().from(schema.opsEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'server_error', detail: '500 boom', path: '/api/x' })
  })

  it('truncates long details rather than storing an entire stack trace', async () => {
    await recordOpsEvent(db, { kind: 'server_error', detail: 'x'.repeat(2000) })
    const rows = await db.select().from(schema.opsEvents)
    expect(rows[0]!.detail).toHaveLength(500)
  })

  it('never throws — alerting must not break the request it is reporting on', async () => {
    const broken = {
      insert: () => {
        throw new Error('db gone')
      },
    } as never
    await expect(recordOpsEvent(broken, { kind: 'server_error' })).resolves.toBeUndefined()
  })
})

describe('recordUnauthenticatedOpsEvent', () => {
  beforeEach(() => resetUnauthenticatedOpsThrottleForTest())

  it('writes one row per kind and detail per interval, however many requests arrive', async () => {
    const event = {
      kind: 'paddle_webhook_rejected',
      detail: 'signature rejected: signature_mismatch',
    }
    const t0 = 1_000_000
    for (let i = 0; i < 50; i++) await recordUnauthenticatedOpsEvent(db, event, t0 + i)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(1)

    await recordUnauthenticatedOpsEvent(db, event, t0 + UNAUTHENTICATED_OPS_INTERVAL_MS)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(2)
  })

  it('throttles each detail separately, so a new failure reason still lands', async () => {
    const t0 = 2_000_000
    await recordUnauthenticatedOpsEvent(db, { kind: 'k', detail: 'a' }, t0)
    await recordUnauthenticatedOpsEvent(db, { kind: 'k', detail: 'b' }, t0)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(2)
  })
})

describe('recentOpsEvents', () => {
  it('returns the window newest first', async () => {
    await spool('server_error', 1, new Date(NOW.getTime() - 2 * DAY_MS))
    await spool('source_failed', 1, new Date(NOW.getTime() - 60 * 60 * 1000))
    await spool('server_error', 1, NOW)

    const rows = await recentOpsEvents(db, { hours: 24, now: NOW })
    expect(rows.map((r) => r.kind)).toEqual(['server_error', 'source_failed'])
    expect(rows[0]).toMatchObject({ created_at: NOW.toISOString() })
  })

  it('filters by kind', async () => {
    await spool('server_error', 2)
    await spool('source_failed', 1)
    const rows = await recentOpsEvents(db, { hours: 1, kind: 'source_failed', now: NOW })
    expect(rows).toHaveLength(1)
  })
})
