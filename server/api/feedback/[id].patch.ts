// Move one feedback row through triage: mark it triaged/closed and link the
// GitHub issue it became. Admin-only.

import { z } from 'zod'

const bodySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  issueUrl: z.url().max(500).nullish(),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing feedback id' })

  const body = await readValidatedBody(event, bodySchema.parse)

  const row = await updateFeedbackStatus(db, id, body)
  if (!row) throw createError({ statusCode: 404, message: 'Feedback not found' })

  return {
    id: row.id,
    status: row.status,
    issueUrl: row.issueUrl,
    updatedAt: row.updatedAt.toISOString(),
  }
})
