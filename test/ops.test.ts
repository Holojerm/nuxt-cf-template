// Ops alerting, run against a real D1 inside workerd.
//
// The guarantee worth testing is not "an email gets built" — it's that the
// spool never loses an event. If the mail transport fails, the rows must stay
// pending so the next tick retries; an alerting system that swallows the alert
// is worse than none, because it reports coverage it doesn't have.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  buildOpsDigest,
  drainOpsEvents,
  OPS_EVENT_RETENTION_DAYS,
  recordOpsEvent,
  type OpsDigest,
} from '../server/utils/ops'

const db = drizzle(env.DB, { schema })

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-21T12:00:00.000Z')
const OPTIONS = { appName: 'My App', workerName: 'my-app', now: NOW }

/** Collects digests instead of mailing them. */
function collector() {
  const sent: OpsDigest[] = []
  return { sent, mail: async (d: OpsDigest) => void sent.push(d) }
}

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

async function pendingCount() {
  const rows = await db.select().from(schema.opsEvents)
  return rows.filter((r) => r.notifiedAt === null).length
}

beforeEach(async () => {
  await db.delete(schema.opsEvents)
})

describe('buildOpsDigest', () => {
  it('returns null when nothing is spooled — silence is the healthy state', () => {
    expect(buildOpsDigest([], OPTIONS)).toBeNull()
  })

  it('names the app, the single kind and the count in the subject', async () => {
    await spool('server_error', 1)
    const rows = await db.select().from(schema.opsEvents)
    expect(buildOpsDigest(rows, OPTIONS)!.subject).toBe('My App: 1 server_error')
  })

  it('pluralizes', async () => {
    await spool('server_error', 3)
    const rows = await db.select().from(schema.opsEvents)
    expect(buildOpsDigest(rows, OPTIONS)!.subject).toBe('My App: 3 server_errors')
  })

  it('leads with the loudest kind when several are mixed', async () => {
    await spool('paddle_webhook_rejected', 5)
    await spool('server_error', 2)
    const rows = await db.select().from(schema.opsEvents)
    const digest = buildOpsDigest(rows, OPTIONS)!
    expect(digest.subject).toBe('My App: 7 events across 2 kinds (paddle_webhook_rejected loudest)')
    // Loudest kind's section comes first in the body too.
    expect(digest.text.indexOf('paddle_webhook_rejected —')).toBeLessThan(
      digest.text.indexOf('server_error —'),
    )
  })

  it('samples three examples per kind and counts the rest', async () => {
    await spool('server_error', 10)
    const rows = await db.select().from(schema.opsEvents)
    const digest = buildOpsDigest(rows, OPTIONS)!
    expect(digest.text).toContain('server_error — 10')
    expect(digest.text).toContain('…and 7 more')
    expect(digest.ids).toHaveLength(10)
  })

  it('links to the Worker’s logs when it knows the Worker, and not otherwise', async () => {
    await spool('server_error', 1)
    const rows = await db.select().from(schema.opsEvents)
    expect(buildOpsDigest(rows, OPTIONS)!.text).toContain(
      '/workers/services/view/my-app/production/observability',
    )
    expect(buildOpsDigest(rows, { appName: 'My App', now: NOW })!.text).not.toContain('Logs:')
  })
})

describe('drainOpsEvents', () => {
  it('does nothing and mails nothing when the spool is empty', async () => {
    const { sent, mail } = collector()
    const result = await drainOpsEvents(db, mail, OPTIONS)
    expect(result).toMatchObject({ pending: 0, sent: false, pruned: 0 })
    expect(sent).toHaveLength(0)
  })

  it('mails once, then marks the rows so the next tick is quiet', async () => {
    await spool('server_error', 4)
    const { sent, mail } = collector()

    const first = await drainOpsEvents(db, mail, OPTIONS)
    expect(first.sent).toBe(true)
    expect(first.pending).toBe(4)
    expect(await pendingCount()).toBe(0)

    const second = await drainOpsEvents(db, mail, OPTIONS)
    expect(second.sent).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('keeps rows pending when the mailer throws, and retries next tick', async () => {
    await spool('server_error', 2)

    const failing = async () => {
      throw new Error('E_SENDER_NOT_VERIFIED')
    }
    const result = await drainOpsEvents(db, failing, OPTIONS)
    expect(result.sent).toBe(false)
    expect(result.error).toContain('E_SENDER_NOT_VERIFIED')
    expect(await pendingCount()).toBe(2)

    const { sent, mail } = collector()
    const retry = await drainOpsEvents(db, mail, OPTIONS)
    expect(retry.sent).toBe(true)
    expect(sent[0]!.ids).toHaveLength(2)
    expect(await pendingCount()).toBe(0)
  })

  it('prunes rows past the retention window and leaves fresh ones', async () => {
    const old = new Date(NOW.getTime() - (OPS_EVENT_RETENTION_DAYS + 1) * DAY_MS)
    await spool('server_error', 3, old)
    await spool('server_error', 1, NOW)

    const { mail } = collector()
    const result = await drainOpsEvents(db, mail, OPTIONS)

    expect(result.pruned).toBe(3)
    const left = await db.select().from(schema.opsEvents)
    expect(left).toHaveLength(1)
  })

  it('prunes even when there is nothing to mail', async () => {
    const old = new Date(NOW.getTime() - (OPS_EVENT_RETENTION_DAYS + 1) * DAY_MS)
    await spool('server_error', 2, old)
    // Mark them already-notified so the drain has no work but the sweep does.
    await db.update(schema.opsEvents).set({ notifiedAt: old })

    const { sent, mail } = collector()
    const result = await drainOpsEvents(db, mail, OPTIONS)
    expect(sent).toHaveLength(0)
    expect(result.pruned).toBe(2)
  })
})

describe('recordOpsEvent', () => {
  it('writes a row the drain will pick up', async () => {
    await recordOpsEvent(db, { kind: 'server_error', detail: '500 boom', path: '/api/x' })
    const rows = await db.select().from(schema.opsEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'server_error', detail: '500 boom', path: '/api/x' })
    expect(rows[0]!.notifiedAt).toBeNull()
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
