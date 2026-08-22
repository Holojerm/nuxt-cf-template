// Deletes the E2E suite's own throwaway rows from the LOCAL dev DB after
// every run.
//
// ── Why this exists ──────────────────────────────────────────────────────
// `bun run ci` runs the `e2e` project on every invocation, and every spec
// mints a fresh user (plus the one global-setup.ts signs in to warm
// /api/auth/dev). Left alone, that's roughly half a dozen users and their
// entitlement rows added to .data/db/sqlite.db on every single run, forever
// — burying the hand-seeded demo/admin/seed-* accounts (scripts/seed.ts)
// under a growing pile of e2e-<run>-<case>@example.com noise nobody asked
// for, in a file nothing else ever prunes.
//
// ── Why node:sqlite, not bun:sqlite ──────────────────────────────────────
// globalTeardown runs inside Playwright's own process, which is Node, not
// Bun — scripts/seed.ts's `bun:sqlite` import isn't available here. Node's
// built-in `node:sqlite` has been usable since 22.13 (see .claude/docs/gotchas.md's own
// node:sqlite gotcha, and package.json's `engines.node` floor), so this adds
// no new dependency.
//
// ── Scope ─────────────────────────────────────────────────────────────────
// Only rows whose email matches the `e2e-` prefix every fixture in this
// suite uses (uniqueEmail() in fixtures.ts, and the warmup account in
// global-setup.ts). Never touches `demo@`, `admin@`, or any `seed-*`
// account scripts/seed.ts writes — none of those match that prefix, so the
// WHERE clause excludes them by construction, not by a separate allowlist
// that could drift.
//
// ── Safety ────────────────────────────────────────────────────────────────
// A no-op whenever the DB file doesn't exist — nothing here is required for
// the suite to have run correctly, and a missing file most likely means the
// dev server was never actually started against it. Writes to
// .data/db/sqlite.db only, which is gitignored (see .gitignore) — this
// never touches a tracked file.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// test/e2e/ -> repo root is two levels up, matching scripts/seed.ts's own
// one-level-up resolution from scripts/ (see DB_PATH there).
const DB_PATH = resolve(here, '../../.data/db/sqlite.db')

export default function globalTeardown(): void {
  if (!existsSync(DB_PATH)) return

  const db = new DatabaseSync(DB_PATH)
  try {
    const rows = db.prepare("SELECT id FROM users WHERE email LIKE 'e2e-%'").all() as {
      id: string
    }[]
    if (rows.length === 0) return

    // entitlements.user_id is a real foreign key (server/db/schema.ts), so
    // child rows go first regardless of whether this SQLite connection has
    // foreign_keys enforcement on.
    const deleteEntitlements = db.prepare('DELETE FROM entitlements WHERE user_id = ?')
    const deleteUser = db.prepare('DELETE FROM users WHERE id = ?')

    db.exec('BEGIN')
    try {
      for (const { id } of rows) {
        deleteEntitlements.run(id)
        deleteUser.run(id)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    console.info(`[e2e globalTeardown] removed ${rows.length} e2e-* user(s) and their entitlements`)
  } finally {
    db.close()
  }
}
