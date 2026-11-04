// GET /api/fleet/feedback — the feedback queue itself, for the fleet dashboard.
//
// The one fleet route that returns rows rather than counts: the owner reads
// feedback in fleet instead of signing in to every app's /admin. Same bearer
// as GET /api/fleet (404 unset, 401 wrong), so holding the fleet token now
// means reading feedback text and who sent it — rotate it like a credential.
// Read-only; triage and replies stay with the app.
//
// Query: ?status=new&limit=50

import { db } from '@nuxthub/db'
import { z } from 'zod'

const querySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'fleet-feedback', limit: 60, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig(event)
  await requireFleetToken(event, {
    current: config.fleetToken,
    previous: config.fleetTokenPrevious,
  })

  const query = await getValidatedQuery(event, querySchema.parse)
  const items = await listFleetFeedback(db, query)
  return { schema: 1, items }
})
