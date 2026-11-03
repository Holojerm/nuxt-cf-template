// Deletes the entitlements the billing E2E specs wrote for their e2e-* users,
// from the LOCAL dev DB, before test/e2e/global-teardown.ts deletes the users
// (entitlements.user_id is a real foreign key, so children go first). See that
// file for why this is node:sqlite and why it only ever touches `e2e-%` rows.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// layers/billing/test/e2e/ -> repo root is four levels up.
const DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.data/db/sqlite.db')

export default function globalTeardown(): void {
  if (!existsSync(DB_PATH)) return

  const db = new DatabaseSync(DB_PATH)
  try {
    const removed = db
      .prepare(
        "DELETE FROM entitlements WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%')",
      )
      .run()
    if (removed.changes) {
      console.info(`[e2e globalTeardown] removed ${removed.changes} e2e-* entitlement(s)`)
    }
  } finally {
    db.close()
  }
}
