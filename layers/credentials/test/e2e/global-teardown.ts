// Runs before core's teardown, which deletes the e2e-* users: the passwords and
// passkeys this layer's spec created reference those rows, so they go first.
// Tokens are keyed by address rather than user id and go the same way.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.data/db/sqlite.db')

const E2E_USERS = "SELECT id FROM users WHERE email LIKE 'e2e-%'"

export default function globalTeardown(): void {
  if (!existsSync(DB_PATH)) return

  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec(`DELETE FROM credential_passwords WHERE user_id IN (${E2E_USERS})`)
    db.exec(`DELETE FROM credential_passkeys WHERE user_id IN (${E2E_USERS})`)
    db.exec("DELETE FROM credential_tokens WHERE email LIKE 'e2e-%'")
  } finally {
    db.close()
  }
}
