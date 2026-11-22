// POST /api/email/updates — "email me product updates", from a visitor with no
// account. Sends the confirmation email and nothing else (server/utils/subscribers.ts).
//
// ── Identical response, always ───────────────────────────────────────────────
// `{ ok: true }` whether the address is new, already confirmed, over its budget
// or refused, so the form cannot be used to learn who is on the list.
//
// ── Mail on a stranger's say-so ──────────────────────────────────────────────
// The same three guards as the sign-in form, for the same reason: a per-IP
// limit, Turnstile before any address-dependent work, and a per-address budget
// charged silently so it is neither an oracle nor a way to lock someone out.
//
// Public: registered by server/plugins/subscribers.ts.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { sendEmail } from '../../../utils/email'
import { emailBranding } from '../../../utils/email-templates'
import { logEvent } from '../../../utils/log'
import { d1RateLimitStore, rateLimit } from '../../../utils/rate-limit'
import { SUBSCRIBE_LIMITER } from '../../../utils/subscriber-requests'
import { buildSubscriberConfirmUrl } from '../../../utils/subscriber-tokens'
import { requestSubscription } from '../../../utils/subscribers'
import { requireTurnstile, turnstileTokenSchema } from '../../../utils/turnstile'

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  // Required by requireTurnstile() only once a secret key is configured.
  turnstileToken: turnstileTokenSchema.nullish(),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, SUBSCRIBE_LIMITER)
  const body = await readValidatedBody(event, bodySchema.parse)
  await requireTurnstile(event, body.turnstileToken)

  const config = useRuntimeConfig(event)
  const outcome = await requestSubscription(db, body.email, {
    brand: emailBranding(),
    send: sendEmail,
    confirmUrl: (id) => buildSubscriberConfirmUrl(config.sessionPassword, config.public.appUrl, id),
    store: d1RateLimitStore(db),
  })

  if (outcome.state === 'unavailable') {
    // As with the sign-in link: a fresh clone has no mail provider, and the dev
    // log is how the flow is exercised end to end there.
    if (import.meta.dev && process.env.NODE_ENV !== 'production') {
      logEvent('info', 'subscribe_confirm_dev', { url: outcome.url })
      return { ok: true }
    }
    // The same for every caller, so it tells nobody anything about an address.
    throw createError({
      statusCode: 503,
      message: 'Could not send the confirmation email',
      data: { code: 'email_unavailable' },
    })
  }

  // The state, never the address.
  logEvent('info', 'subscribe_requested', { state: outcome.state })
  return { ok: true }
})
