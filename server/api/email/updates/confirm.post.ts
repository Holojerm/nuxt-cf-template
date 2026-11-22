// POST /api/email/updates/confirm — the second half of the double opt-in.
//
// A POST from the confirmation page's button, never a GET: every link in
// inbound mail is fetched by a security gateway before a person sees it, and a
// link that confirmed by being fetched would subscribe addresses nobody
// confirmed (the hazard unsubscribe.get.ts describes, in the other direction).
//
// Public: registered by server/plugins/subscribers.ts.

import { db } from '@nuxthub/db'

import { rateLimit, UNSUBSCRIBE_LIMITER } from '../../../utils/rate-limit'
import { authenticateSubscriberRequest } from '../../../utils/subscriber-requests'
import { confirmSubscription } from '../../../utils/subscribers'

export default defineEventHandler(async (event) => {
  await rateLimit(event, UNSUBSCRIBE_LIMITER)
  const { id } = await authenticateSubscriberRequest(event, 'confirm')
  // `gone`: the week ran out and the address was deleted. The page says so.
  return { ok: true, state: await confirmSubscription(db, id) }
})
