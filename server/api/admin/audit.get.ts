// The audit trail itself — GET /api/admin/audit. Admin-only.
//
// Query: ?actorUserId=…&targetId=…&limit=50
//
// ── Why reading this is not itself audited ───────────────────────────────────
// It looks inconsistent next to every other endpoint in this directory, so it
// is worth writing down rather than leaving as an omission someone "fixes".
//
// The table records what was done TO customers. An admin reading it takes no
// action on anyone's account and learns nothing they could not get by re-running
// the underlying reads — which ARE audited. So the row an `audit.viewed` action
// would add carries no information that isn't already recoverable.
//
// What it would cost is the one property that makes this table usable: signal.
// Every console page load would append a row, the trail would fill with admins
// looking at the trail, and the actions that actually matter would be buried
// under them. An audit log nobody can skim at 2am is not an audit log.
//
// The same reasoning does NOT extend to the user search or the detail page,
// which read another person's email, billing, and support history — those are
// privileged reads of customer data and are audited.

import { z } from 'zod'

const querySchema = z.object({
  /** Everything one admin did — the index the table carries. */
  actorUserId: z.string().trim().max(64).optional(),
  /** Everything done to one subject. */
  targetId: z.string().trim().max(64).optional(),
  targetType: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const query = await getValidatedQuery(event, querySchema.parse)
  const rows = await listAudit(db, query)

  // Emails are resolved here rather than stored on the row — the audit table is
  // append-only and never pruned, so an address written into it would outlive
  // the account and quietly break the deletion promise on /account. See
  // server/utils/audit.ts › "What does NOT go in metadata", and
  // resolveAuditSubjectEmails for why the lookup is chunked.
  const emailById = await resolveAuditSubjectEmails(db, rows)

  return {
    items: rows.map((row) => ({
      ...toAuditView(row),
      /** Display only, resolved live. Null once the account is deleted. */
      targetEmail: row.targetId ? (emailById.get(row.targetId) ?? null) : null,
    })),
    total: rows.length,
  }
})
