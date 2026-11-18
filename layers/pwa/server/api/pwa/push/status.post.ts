// POST /api/pwa/push/status — whether this browser's subscription belongs to
// the signed-in account. The browser alone cannot say: it keeps a subscription
// across sign-ins, so the one it holds may be the last person's. A POST so the
// endpoint, a capability URL, stays out of the query string and the logs.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { rateLimit } from '#server/utils/rate-limit'
import { PUSH_LIMIT, requirePush } from '../../../utils/push'
import { hasPushSubscription, pushEndpointSchema } from '../../../utils/push-subscriptions'

const bodySchema = z.object({ endpoint: pushEndpointSchema })

export default defineEventHandler(async (event) => {
  requirePush(event)
  await rateLimit(event, PUSH_LIMIT)
  const { user } = await requireUserSession(event)
  const { endpoint } = await readValidatedBody(event, bodySchema.parse)
  return { subscribed: await hasPushSubscription(db, user.id, endpoint) }
})
