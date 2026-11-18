// Runs before core's teardown, which deletes the e2e-* users: the push
// subscriptions this layer's spec stored name those users, so they go first.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.data/db/sqlite.db')

export default function globalTeardown(): void {
  if (!existsSync(DB_PATH)) return

  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec(
      "DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%')",
    )
  } finally {
    db.close()
  }
}
