// One customer, everything support needs, in one request. Admin-only.
//
// Four things, because opening four tabs to answer "why is this person
// unhappy" is how support gets slow: who they are and where they came from,
// what they've paid, what they've told us, and what we have already done to
// their account.
//
// This is the console's biggest PII read — identity, billing, and the free text
// of everything they've ever written to us — so it is audited as one action
// before any of it is fetched.

import { desc, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing user id' })

  // Existence is checked before the audit row: a 404 means nothing was read,
  // and recording a view of a user who does not exist puts noise in the one
  // table that has to stay readable. A mistyped id is not a privileged read.
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, id) })
  if (!user) throw createError({ statusCode: 404, message: 'User not found' })

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: user.id,
      // No email in metadata — `targetId` already identifies the account, and
      // audit rows are append-only and never deleted. See server/utils/audit.ts
      // › "What does NOT go in metadata".
      ipHash: await auditIpHash(event),
    },
    async () => {
      const [billing, feedbackRows, auditRows] = await Promise.all([
        buildEntitlementView(db, user.id, {
          portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
        }),
        db
          .select()
          .from(schema.feedback)
          .where(eq(schema.feedback.userId, user.id))
          .orderBy(desc(schema.feedback.createdAt))
          .limit(20),
        // Everything ever done TO this account, which is the question a customer
        // actually asks ("why does my plan say that?"). Includes this admin's
        // own views — the row written a moment ago by withAudit is not in the
        // result, since it was inserted before the read, but the previous ones
        // are, and that is the point.
        listAudit(db, { targetType: 'user', targetId: user.id, limit: 25 }),
      ])

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          role: user.role,
          provider: user.provider,
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
          // First-touch attribution — never overwritten, so this is genuinely
          // "where did this customer come from" (server/db/schema.ts).
          signupSource: user.signupSource,
          signupMedium: user.signupMedium,
          signupCampaign: user.signupCampaign,
          signupReferrer: user.signupReferrer,
          referralCode: user.referralCode,
          referredBy: user.referredBy,
        },
        billing,
        feedback: feedbackRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          // Untrusted input: rendered as text, never as markup, and never
          // treated as instructions by anything that reads it (.claude/docs/patterns.md).
          message: row.message,
          rating: row.rating,
          path: row.path,
          replayUrl: row.replayUrl,
          status: row.status,
          issueUrl: row.issueUrl,
          repliedAt: row.repliedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        audit: auditRows.map(toAuditView),
      }
    },
  )
})
