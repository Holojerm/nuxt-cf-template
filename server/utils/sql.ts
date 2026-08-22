// SQL fragments that are easy to get subtly wrong, written once.
//
// Everything here is pure and imports nothing from Nitro, because the money
// code (server/utils/entitlements.ts) uses it and the workerd vitest suite
// loads that file directly.

import { sql } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'

/**
 * `column LIKE '<prefix>%'` with the wildcards in `prefix` neutralised.
 *
 * ── Why this is a function and not a `like()` call ───────────────────────────
 * SQL's LIKE has two wildcards, and `_` is the one everybody forgets: it
 * matches ANY single character. `like(col, 'sub_%')` therefore does not mean
 * "starts with `sub_`" — it means "starts with `sub`, then anything". A ref of
 * `subs_fake` matches it, and in `findActiveEntitlement` that difference is the
 * whole gate: `sub_`-prefixed rows grant access on status alone, with no expiry
 * check, so a ref that merely *looks* like one to an unescaped LIKE would grant
 * access that never ends.
 *
 * The same hole in the admin user search is a directory dump: `q=%` matches
 * every address in the table.
 *
 * Escaping rather than stripping, because `_` is legal in both an email local
 * part and our own ref prefixes — the character has to survive, just not as a
 * wildcard. The ESCAPE clause is bundled in here rather than left to callers:
 * SQLite ignores backslashes in LIKE patterns unless you ask, so a pattern
 * built without it is silently the unescaped behaviour again.
 */
export function likePrefix(column: AnyColumn, prefix: string): SQL {
  const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
  // `'\'` is a one-character string in SQLite — it processes no backslash
  // escapes inside string literals, unlike most other dialects.
  return sql`${column} like ${pattern} escape '\\'`
}
