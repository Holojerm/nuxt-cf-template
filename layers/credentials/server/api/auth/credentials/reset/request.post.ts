// POST /api/auth/credentials/reset/request — mail a reset link, if there is
// anyone to mail. The answer is `{ ok: true }` whatever happened.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { logEvent } from '#server/utils/log'
import { rateLimit } from '#server/utils/rate-limit'
import { requireTurnstile, turnstileTokenSchema } from '#server/utils/turnstile'
import { credentialsEmailSchema } from '../../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled } from '../../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../../utils/credentials-limits'
import { sendCredentialLink } from '../../../../utils/credentials-mail'
import { requestPasswordReset } from '../../../../utils/credentials-reset'

const bodySchema = z.object({
  email: credentialsEmailSchema,
  turnstileToken: turnstileTokenSchema.nullish(),
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.resetRequest)
  const body = await readValidatedBody(event, bodySchema.parse)
  await requireTurnstile(event, body.turnstileToken)

  const request = await requestPasswordReset(db, body.email)
  if (!request.deliver) {
    if (!request.withinBudget) {
      logEvent('warn', 'credentials_mail_budget_exhausted', { purpose: 'reset' })
    }
    return { ok: true }
  }

  // No 503 on a failed send, unlike sign-up: only an address with an account is
  // mailed here, so reporting an outage would report the account.
  const outcome = await sendCredentialLink('reset', {
    to: request.record.email,
    token: request.token,
    recordId: request.record.id,
  })
  return { ok: true, devLink: outcome.devLink }
})
