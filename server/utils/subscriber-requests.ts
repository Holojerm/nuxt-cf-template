// The request half of server/utils/subscribers.ts: reading and authenticating
// the two links a subscriber is mailed. Apart from that file so it stays free of
// H3 and the workerd tests can load it.

import { z } from 'zod'
import type { H3Event } from 'h3'

import { verifySubscriberToken, type SubscriberTokenPurpose } from './subscriber-tokens'

/**
 * The form's own budget, per IP. Deliberately not the native limiter's numbers
 * (server/utils/rate-limit.ts), so the count is exact.
 */
export const SUBSCRIBE_LIMITER = { name: 'email-updates', limit: 10, windowSeconds: 600 }

export const subscriberLinkSchema = z.object({
  s: z.string().trim().min(1).max(64),
  t: z.string().trim().min(1).max(512),
})

/**
 * Body first, query second, as in unsubscribe.ts and for its reason: the pages
 * POST a body so the token stays out of request logs, while a mail provider's
 * one-click POST and the footer link carry the parameters in the URL.
 */
async function readSubscriberLink(event: H3Event) {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    const body = await readBody(event).catch(() => null)
    const parsed = subscriberLinkSchema.safeParse(body)
    if (parsed.success) return parsed.data
  }
  return getValidatedQuery(event, subscriberLinkSchema.parse)
}

/** The subscriber id a signed link names, or a 400. Writes nothing. */
export async function authenticateSubscriberRequest(
  event: H3Event,
  purpose: SubscriberTokenPurpose,
): Promise<{ id: string; token: string }> {
  const { s: id, t: token } = await readSubscriberLink(event)
  const valid = await verifySubscriberToken(
    useRuntimeConfig(event).sessionPassword,
    purpose,
    id,
    token,
  )
  if (!valid) throw createError({ statusCode: 400, message: 'Invalid or expired link' })
  return { id, token }
}
