// Move one feedback row through triage: mark it triaged/closed and link the
// GitHub issue it became. Admin-only.

import { z } from 'zod'

const bodySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  issueUrl: z.url().max(500).nullish(),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing feedback id' })

  const body = await readValidatedBody(event, bodySchema.parse)

  // Read before the audit row for two reasons: a missing row means nothing
  // happened and should 404 without leaving a record (same rule the admin
  // endpoints follow), and the prior status is the half of "new → closed" that
  // stops existing the instant the update lands.
  const existing = await findFeedbackById(db, id)
  if (!existing) throw createError({ statusCode: 404, message: 'Feedback not found' })

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'feedback.status_changed',
      targetType: 'feedback',
      targetId: existing.id,
      metadata: {
        from: existing.status,
        to: body.status ?? existing.status,
        issueUrl: body.issueUrl ?? null,
      },
      ipHash: await auditIpHash(event),
    },
    async () => {
      const row = await updateFeedbackStatus(db, id, body)
      if (!row) throw createError({ statusCode: 404, message: 'Feedback not found' })

      return {
        id: row.id,
        status: row.status,
        issueUrl: row.issueUrl,
        updatedAt: row.updatedAt.toISOString(),
      }
    },
  )
})
