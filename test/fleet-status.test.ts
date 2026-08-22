// What /api/status and /api/fleet report, against a real D1 inside workerd.
//
// The migration half matters most: `applyD1Migrations` (test/setup.ts) records
// what it applied in `d1_migrations`, the same table `bun run db:migrate:remote`
// writes in production, so this is the real reader against the real tracking
// table — not a fixture that drifts from it.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  collectFleetCounters,
  compareMigrations,
  readAppliedMigrations,
  repoMigrations,
} from '../server/utils/fleet-status'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-08-22T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

describe('repoMigrations', () => {
  it('lists the journal, oldest first, as drizzle-kit tags', () => {
    const tags = repoMigrations()
    expect(tags.length).toBeGreaterThanOrEqual(14)
    expect(tags[0]).toBe('0000_wakeful_forgotten_one')
    expect(tags.at(-1)).toMatch(/^\d{4}_[a-z_]+$/)
    expect(tags).toEqual([...tags].sort())
  })
})

describe('readAppliedMigrations', () => {
  it('reads the table the migration tool wrote, and it matches the repo exactly', async () => {
    const applied = await readAppliedMigrations(db)
    expect(applied.table).toBe('d1_migrations')
    expect(applied.names).toHaveLength(repoMigrations().length)

    const drift = compareMigrations(repoMigrations(), applied.names)
    expect(drift).toEqual({ pending: [], unknown: [] })
  })

  it('reports nothing applied, rather than throwing, when no tracking table exists', async () => {
    // A database that was created but never migrated is the other realistic
    // state, and a liveness route must describe it rather than 500 on it.
    await env.DB.exec('ALTER TABLE d1_migrations RENAME TO d1_migrations_hidden')
    try {
      expect(await readAppliedMigrations(db)).toEqual({ table: null, names: [] })
    } finally {
      await env.DB.exec('ALTER TABLE d1_migrations_hidden RENAME TO d1_migrations')
    }
  })

  it('falls through to _hub_migrations when that is the table in use', async () => {
    await env.DB.exec('ALTER TABLE d1_migrations RENAME TO _hub_migrations')
    try {
      const applied = await readAppliedMigrations(db)
      expect(applied.table).toBe('_hub_migrations')
      expect(applied.names).toHaveLength(repoMigrations().length)
    } finally {
      await env.DB.exec('ALTER TABLE _hub_migrations RENAME TO d1_migrations')
    }
  })
})

describe('compareMigrations', () => {
  it('names what the repo has that production does not — the outage-in-waiting', () => {
    const drift = compareMigrations(['0000_a', '0001_b', '0002_c'], ['0000_a.sql', '0001_b.sql'])
    expect(drift).toEqual({ pending: ['0002_c'], unknown: [] })
  })

  it('names what production applied that the repo no longer has', () => {
    const drift = compareMigrations(['0000_a'], ['0000_a.sql', '0001_deleted.sql'])
    expect(drift).toEqual({ pending: [], unknown: ['0001_deleted'] })
  })

  it('treats a tag and its .sql filename as the same migration', () => {
    expect(compareMigrations(['0000_a'], ['0000_a'])).toEqual({ pending: [], unknown: [] })
    expect(compareMigrations(['0000_a'], ['0000_a.sql'])).toEqual({ pending: [], unknown: [] })
  })

  it('reports everything pending for a database never migrated', () => {
    expect(compareMigrations(['0000_a', '0001_b'], []).pending).toEqual(['0000_a', '0001_b'])
  })
})

describe('collectFleetCounters', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM entitlements')
    await env.DB.exec('DELETE FROM feedback')
    await env.DB.exec('DELETE FROM ops_events')
    await env.DB.exec('DELETE FROM users')
  })

  it('is all zeros on an empty database', async () => {
    expect(await collectFleetCounters(db, NOW)).toEqual({
      users: { total: 0, last7d: 0 },
      entitlements: { byStatus: {} },
      opsEvents: { pending: 0, last24h: 0 },
      feedback: { total: 0, open: 0 },
      extra: {},
    })
  })

  it('counts, and only counts — no rows, no ids, no addresses leave', async () => {
    const recent = new Date(NOW.getTime() - 2 * DAY_MS)
    const old = new Date(NOW.getTime() - 30 * DAY_MS)
    await db.insert(schema.users).values([
      { id: 'u-new', email: 'new@example.com', name: 'New', createdAt: recent, updatedAt: recent },
      { id: 'u-old', email: 'old@example.com', name: 'Old', createdAt: old, updatedAt: old },
    ])
    await db.insert(schema.entitlements).values([
      { userId: 'u-new', paddleSubscriptionId: 'sub_1', status: 'active' },
      { userId: 'u-old', paddleSubscriptionId: 'sub_2', status: 'active' },
      { userId: 'u-old', paddleSubscriptionId: 'txn_3', status: 'canceled' },
    ])
    const hourAgo = new Date(NOW.getTime() - 60 * 60 * 1000)
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY_MS)
    await db.insert(schema.opsEvents).values([
      { kind: 'server_error', createdAt: hourAgo, updatedAt: hourAgo },
      { kind: 'server_error', createdAt: hourAgo, updatedAt: hourAgo, notifiedAt: hourAgo },
      {
        kind: 'server_error',
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
        notifiedAt: twoDaysAgo,
      },
    ])
    await db.insert(schema.feedback).values([
      { message: 'love it', status: 'new' },
      { message: 'broken', status: 'new' },
      { message: 'fixed now', status: 'closed' },
    ])

    const counters = await collectFleetCounters(db, NOW)
    expect(counters.users).toEqual({ total: 2, last7d: 1 })
    expect(counters.entitlements.byStatus).toEqual({ active: 2, canceled: 1 })
    expect(counters.opsEvents).toEqual({ pending: 1, last24h: 2 })
    expect(counters.feedback).toEqual({ total: 3, open: 2 })

    // The payload is stored for months in someone else's database: it must be
    // numbers all the way down.
    const leaves = JSON.stringify(counters).match(/"[^"]*":\s*"[^"]*"/g) ?? []
    expect(leaves).toEqual([])
  })
})
