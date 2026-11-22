// POST /api/email/updates/unsubscribe — removes a subscriber. Two callers: a mail
// provider's one-click button (RFC 8058, parameters in the URL) and the
// /unsubscribe page's button (parameters in the body).
//
// Removing is deleting: the address is not kept. A link for a row that is
// already gone answers the same 200, so it says nothing about who was on the list.
//
// Public: registered by server/plugins/subscribers.ts.

import { db } from '@nuxthub/db'

import { rateLimit, UNSUBSCRIBE_LIMITER } from '../../../utils/rate-limit'
import { authenticateSubscriberRequest } from '../../../utils/subscriber-requests'
import { removeSubscriber } from '../../../utils/subscribers'

export default defineEventHandler(async (event) => {
  await rateLimit(event, UNSUBSCRIBE_LIMITER)
  const { id } = await authenticateSubscriberRequest(event, 'leave')
  await removeSubscriber(db, id)
  return { ok: true }
})
