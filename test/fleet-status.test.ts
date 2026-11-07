// What /api/status and /api/fleet report, against a real D1 inside workerd.
//
// The migration half matters most: `applyD1Migrations` (test/setup.ts) records
// what it applied in `d1_migrations`, the same table `bun run db:migrate:remote`
// writes in production, so this is the real reader against the real tracking
// table — not a fixture that drifts from it.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { clearExtensionsForTest, registerFleetExtraContributor } from '../server/utils/extensions'
import {
  collectFleetCounters,
  FLEET_OPS_KIND_LIMIT,
  compareMigrations,
  readAppliedMigrations,
  repoMigrations,
} from '../server/utils/fleet-status'
import {
  registerOpsSeverity,
  resetOpsSeverityForTest,
  SERVER_ERROR_CRITICAL_COUNT,
} from '../server/utils/ops-severity'

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
    await env.DB.exec('DELETE FROM audit_log')
    await env.DB.exec('DELETE FROM ops_events')
    await env.DB.exec('DELETE FROM users')
  })

  describe('extra contributors', () => {
    afterEach(() => clearExtensionsForTest())

    it('merges every contributor into `extra` and leaves the rest of the shape alone', async () => {
      registerFleetExtraContributor({
        key: 'coaching',
        collect: async () => ({ athletes: 3, plans: 5 }),
      })
      registerFleetExtraContributor({
        key: 'sessions',
        collect: async (_db, now) => ({ sessionsLogged: now.getTime() === NOW.getTime() ? 7 : 0 }),
      })

      const counters = await collectFleetCounters(db, NOW)
      expect(counters.extra).toEqual({ athletes: 3, plans: 5, sessionsLogged: 7 })
      expect(Object.keys(counters).sort()).toEqual(['extra', 'funnel', 'ops', 'users'].sort())
    })

    it('replaces rather than duplicates a contributor registered twice', async () => {
      registerFleetExtraContributor({ key: 'k', collect: async () => ({ a: 1 }) })
      registerFleetExtraContributor({ key: 'k', collect: async () => ({ a: 2 }) })
      expect((await collectFleetCounters(db, NOW)).extra).toEqual({ a: 2 })
    })
  })

  it('is all zeros on an empty database', async () => {
    expect(await collectFleetCounters(db, NOW)).toEqual({
      users: { total: 0, last7d: 0 },
      ops: { kinds: [] },
      funnel: { cohortDays: 28, signups: 0, activated: 0, paid: 0, sources: {} },
      extra: {},
    })
  })

  it('leaks no rows, ids or addresses beyond the per-kind ops summary', async () => {
    const recent = new Date(NOW.getTime() - 2 * DAY_MS)
    const old = new Date(NOW.getTime() - 30 * DAY_MS)
    await db.insert(schema.users).values([
      { id: 'u-new', email: 'new@example.com', name: 'New', createdAt: recent, updatedAt: recent },
      { id: 'u-old', email: 'old@example.com', name: 'Old', createdAt: old, updatedAt: old },
    ])
    const counters = await collectFleetCounters(db, NOW)
    expect(counters.users).toEqual({ total: 2, last7d: 1 })

    // The payload is stored for months in someone else's database: it must be
    // numbers all the way down (ops summaries are covered below).
    const leaves = JSON.stringify(counters).match(/"[^"]*":\s*"[^"]*"/g) ?? []
    expect(leaves).toEqual([])
  })
})

describe('collectFleetCounters › ops.kinds', () => {
  const HOUR_MS = 60 * 60 * 1000
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR_MS)

  async function spool(
    kind: string,
    createdAt: Date,
    extra: { detail?: string; path?: string } = {},
  ) {
    await db.insert(schema.opsEvents).values({ kind, createdAt, updatedAt: createdAt, ...extra })
  }

  beforeEach(async () => {
    await db.delete(schema.opsEvents)
    resetOpsSeverityForTest()
  })
  afterEach(() => resetOpsSeverityForTest())

  it('groups the last 24 h by kind with the newest row summary, and ignores older rows', async () => {
    await spool('server_error', at(3), { detail: 'older', path: '/api/a' })
    await spool('server_error', at(1), { detail: 'newest', path: '/api/b' })
    await spool('server_error', at(30), { detail: 'outside the window' })
    await spool('source_failed', at(25))

    const { kinds } = (await collectFleetCounters(db, NOW)).ops
    expect(kinds).toEqual([
      {
        kind: 'server_error',
        severity: 'warning',
        count: 2,
        lastAt: at(1).toISOString(),
        lastDetail: 'newest',
        lastPath: '/api/b',
      },
    ])
  })

  it('reports null detail and path when the newest row has none', async () => {
    await spool('quiet', at(1))
    expect((await collectFleetCounters(db, NOW)).ops.kinds[0]).toMatchObject({
      lastDetail: null,
      lastPath: null,
    })
  })

  it('ranks critical, then warning, then info, then by count', async () => {
    registerOpsSeverity({
      payments_dropped: { severity: 'critical' },
      export_noted: { severity: 'info' },
    })
    for (let i = 0; i < 5; i++) await spool('export_noted', at(1))
    for (let i = 0; i < 2; i++) await spool('few_warn', at(1))
    for (let i = 0; i < 4; i++) await spool('many_warn', at(1))
    await spool('payments_dropped', at(1))

    const { kinds } = (await collectFleetCounters(db, NOW)).ops
    expect(kinds.map((k) => [k.kind, k.severity, k.count])).toEqual([
      ['payments_dropped', 'critical', 1],
      ['many_warn', 'warning', 4],
      ['few_warn', 'warning', 2],
      ['export_noted', 'info', 5],
    ])
  })

  it('escalates a server_error burst to critical', async () => {
    for (let i = 0; i < SERVER_ERROR_CRITICAL_COUNT; i++) await spool('server_error', at(1))
    expect((await collectFleetCounters(db, NOW)).ops.kinds[0]).toMatchObject({
      kind: 'server_error',
      severity: 'critical',
    })
  })

  it('caps the list at FLEET_OPS_KIND_LIMIT kinds', async () => {
    for (let i = 0; i < FLEET_OPS_KIND_LIMIT + 5; i++) await spool(`kind_${i}`, at(1))
    expect((await collectFleetCounters(db, NOW)).ops.kinds).toHaveLength(FLEET_OPS_KIND_LIMIT)
  })
})
