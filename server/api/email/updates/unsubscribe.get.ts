// GET /api/email/updates/unsubscribe — the footer link in mail to a subscriber.
//
// Like unsubscribe.get.ts beside it, this GET removes nobody: mail gateways
// fetch every link on delivery. It checks the token and hands off to the
// /unsubscribe page, whose button POSTs. The parameters move to the fragment so
// the page's own request carries no token.
//
// Public: registered by server/plugins/subscribers.ts.

import { rateLimit, UNSUBSCRIBE_LIMITER } from '../../../utils/rate-limit'
import { authenticateSubscriberRequest } from '../../../utils/subscriber-requests'

export default defineEventHandler(async (event) => {
  await rateLimit(event, UNSUBSCRIBE_LIMITER)
  const { id, token } = await authenticateSubscriberRequest(event, 'leave')
  const params = new URLSearchParams({ s: id, t: token })
  return sendRedirect(event, `/unsubscribe#${params.toString()}`)
})
