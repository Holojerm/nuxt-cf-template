// POST /api/auth/credentials/sign-up — start a sign-up: mail the address a link.
// Nothing becomes an account here, and no password is taken yet (see
// credentials-signup.ts for why it is chosen after the link is opened).
//
// Answers `{ ok: true }` for every address, including one that already has an
// account: who is registered is visible only to whoever opens the mail.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { ATTRIBUTION_COOKIE, readAttributionCookie } from '#shared/utils/attribution'
import { logEvent } from '#server/utils/log'
import { rateLimit } from '#server/utils/rate-limit'
import { requireTurnstile, turnstileTokenSchema } from '#server/utils/turnstile'
import { isUndeliverableAddress, normalizeEmail } from '#server/utils/users'
import { credentialsEmailSchema } from '../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { sendCredentialLink } from '../../../utils/credentials-mail'
import { startSignUp } from '../../../utils/credentials-signup'

const bodySchema = z.object({
  email: credentialsEmailSchema,
  turnstileToken: turnstileTokenSchema.nullish(),
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.signUp)
  const body = await readValidatedBody(event, bodySchema.parse)

  // Before the mailbox budget is charged: a challenge behind the budget lets an
  // unsolved bot spend a stranger's mail allowance and lock them out of sign-up.
  await requireTurnstile(event, body.turnstileToken)

  const email = normalizeEmail(body.email)
  if (isUndeliverableAddress(email)) {
    logEvent('warn', 'credentials_reserved_address_refused')
    return { ok: true }
  }

  const { token, record, withinBudget } = await startSignUp(db, {
    email,
    attribution: readAttributionCookie(getCookie(event, ATTRIBUTION_COOKIE)),
  })
  if (!withinBudget) {
    logEvent('warn', 'credentials_mail_budget_exhausted', { purpose: 'verify' })
    return { ok: true }
  }

  const outcome = await sendCredentialLink('verify', { to: email, token, recordId: record.id })
  if (!outcome.delivered) {
    // Honest about an outage, and safe to be: every address is mailed here, so
    // a 503 says nothing about this one.
    throw createError({
      statusCode: 503,
      message: 'Could not send the verification email',
      data: { code: 'email_unavailable' },
    })
  }
  return { ok: true, devLink: outcome.devLink }
})
