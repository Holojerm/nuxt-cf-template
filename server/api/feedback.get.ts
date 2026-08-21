// Admin feedback list — the in-app half of triage. The `feedback-triage`
// routine reads the same rows over `wrangler d1 execute --remote`; this exists
// so a human can skim the queue without opening a SQL console.
//
// Query: ?status=new&limit=50&since=<ISO date>

import { z } from 'zod'

const querySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)

  const query = await getValidatedQuery(event, querySchema.parse)

  const items = await listFeedback(db, {
    status: query.status,
    since: query.since ? new Date(query.since) : undefined,
    limit: query.limit,
  })

  return {
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      message: item.message,
      rating: item.rating,
      email: item.email,
      path: item.path,
      replayUrl: item.replayUrl,
      userId: item.userId,
      status: item.status,
      issueUrl: item.issueUrl,
      createdAt: item.createdAt.toISOString(),
    })),
    total: items.length,
  }
})
