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

import { asc } from 'drizzle-orm'
import { z } from 'zod'

const querySchema = z.object({
  /** Full address or a prefix of one. Two characters minimum — see below. */
  q: z.string().trim().min(2).max(320),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

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
      // No target: a search has no single subject.
      //
      // The needle is stored as a SALTED HASH, never as the address. "Who did
      // this admin go looking for" is genuinely the question auditing a search
      // answers, and a hash still answers it: an investigator who suspects an
      // address hashes it and compares. What it does not do is leave a readable
      // email in a table that is append-only, never pruned, and therefore
      // outlives the account — which would have undone the live-join redaction
      // the rest of this trail is built on and broken the same deletion promise
      // /account makes. Salting matters here specifically: a bare SHA-256 of an
      // email is reversed by hashing a list of emails.
      //
      // No result count, because metadata is written before the action under
      // audit-before-act and the outcome is not knowable yet — the same reason
      // a grant records its intent rather than the resulting expiry.
      metadata: {
        queryHash: await saltedHash(needle, useRuntimeConfig(event).sessionPassword),
        /** Distinguishes a two-letter fishing trip from a full address. */
        queryLength: needle.length,
        limit: query.limit,
      },
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
        // both. likePrefix() neutralises the LIKE wildcards — without it `q=%`
        // is a one-character dump of every address in the table. It lives in
        // server/utils/sql.ts because the money code needs the same escaping
        // (see findActiveEntitlement) and a second copy is how the two drift.
        .where(likePrefix(schema.users.email, needle))
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
