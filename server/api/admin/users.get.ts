// Find a customer by email — the front door of the admin console. Admin-only.
//
// Query: ?q=jane@example.com&limit=20
//
// Email only, deliberately. Support conversations arrive as an email address
// (it is the account key — see server/utils/users.ts), and a free-text search
// across names would return "every John" to someone who is one keystroke from
// reading a stranger's billing history. Narrow search is a privacy control.
//
// This is a PII read and is audited as one. `withAudit` writes the row first,
// so the needle is recorded even if the query itself then fails.

import { asc, sql } from 'drizzle-orm'
import { z } from 'zod'

const querySchema = z.object({
  /** Full address or a prefix of one. Two characters minimum — see below. */
  q: z.string().trim().min(2).max(320),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * Prefix pattern with the LIKE wildcards neutralised.
 *
 * Without this, `q=%` matches every user in the database — a one-character
 * directory dump. Escaping (rather than stripping) keeps `_`, which is a legal
 * character in an email local part, meaning itself instead of "any character".
 */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const query = await getValidatedQuery(event, querySchema.parse)

  // Same normalisation sign-in uses, so a support person pasting "Jane@Foo.com"
  // out of an email client finds the row stored as "jane@foo.com".
  const needle = normalizeEmail(query.q)

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'admin.user_searched',
      // No target: a search has no single subject. The needle IS the fact worth
      // recording — "who did this admin go looking for" is the question an
      // audit of a support team answers, and a result count would not tell you.
      metadata: { query: needle, limit: query.limit },
      ipHash: await auditIpHash(event),
    },
    async () => {
      const rows = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.users.role,
          provider: schema.users.provider,
          lastLoginAt: schema.users.lastLoginAt,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        // An exact address is just the degenerate prefix, so one clause covers
        // both. `escape '\'` is what makes likePrefix() above mean anything —
        // SQLite ignores backslashes in LIKE patterns unless you ask.
        .where(sql`${schema.users.email} like ${likePrefix(needle)} escape '\\'`)
        .orderBy(asc(schema.users.email))
        .limit(query.limit)

      return {
        items: rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          provider: row.provider,
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        total: rows.length,
        /** True when the cap may be hiding matches — the UI says "narrow it". */
        capped: rows.length === query.limit,
      }
    },
  )
})
