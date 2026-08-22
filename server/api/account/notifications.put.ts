// Toggle one optional email type for the signed-in user.
//
// The Zod enum is the first line of defense against ever writing a row for a
// mandatory type: `eventType` can only be one of OPTIONAL_NOTIFICATION_EVENT_TYPES,
// so `billing.payment_failed` 400s here before setNotificationPreference()'s
// own belt-and-suspenders check would ever run.

import { z } from 'zod'

const bodySchema = z.object({
  eventType: z.enum(OPTIONAL_NOTIFICATION_EVENT_TYPES),
  enabled: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readValidatedBody(event, bodySchema.parse)

  await setNotificationPreference(db, user.id, body.eventType, body.enabled)

  return { eventType: body.eventType, enabled: body.enabled }
})
