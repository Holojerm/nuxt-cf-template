// POST /api/pwa/push/unsubscribe — forget this browser's subscription. A POST
// because the endpoint travels in the body, and Workers drop a DELETE's.
// Answers the same whether or not there was a row: off is off.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { rateLimit } from '#server/utils/rate-limit'
import { PUSH_LIMIT, requirePush } from '../../../utils/push'
import { pushEndpointSchema, removePushSubscription } from '../../../utils/push-subscriptions'

const bodySchema = z.object({ endpoint: pushEndpointSchema })

export default defineEventHandler(async (event) => {
  requirePush(event)
  await rateLimit(event, PUSH_LIMIT)
  const { user } = await requireUserSession(event)
  const { endpoint } = await readValidatedBody(event, bodySchema.parse)
  await removePushSubscription(db, user.id, endpoint)
  return { subscribed: false }
})
