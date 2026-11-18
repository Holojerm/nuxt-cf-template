// POST /api/pwa/push/subscribe — store this browser's subscription for the
// signed-in account. The body is `PushSubscription.toJSON()`.

import { db } from '@nuxthub/db'

import { rateLimit } from '#server/utils/rate-limit'
import { PUSH_LIMIT, requirePush } from '../../../utils/push'
import { pushSubscriptionSchema, savePushSubscription } from '../../../utils/push-subscriptions'

export default defineEventHandler(async (event) => {
  requirePush(event)
  await rateLimit(event, PUSH_LIMIT)
  const { user } = await requireUserSession(event)
  const subscription = await readValidatedBody(event, pushSubscriptionSchema.parse)
  await savePushSubscription(db, user.id, subscription)
  return { subscribed: true }
})
