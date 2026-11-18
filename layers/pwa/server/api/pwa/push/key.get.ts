// GET /api/pwa/push/key — the VAPID public key a browser subscribes with.
// 404 until the app has both keys, which is how the client knows push is off.

import { rateLimit } from '#server/utils/rate-limit'
import { PUSH_LIMIT, requirePush } from '../../../utils/push'

export default defineEventHandler(async (event) => {
  const keys = requirePush(event)
  await rateLimit(event, PUSH_LIMIT)
  await requireUserSession(event)
  return { publicKey: keys.publicKey }
})
