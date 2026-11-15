// POST /api/auth/credentials/reset/confirm — spend a reset link: set the new
// password, end every older session, run the app's reset hook, and sign in.

import { db } from '@nuxthub/db'

import { establishSession } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import {
  credentialsNewPasswordSchema,
  credentialsTokenSchema,
} from '../../../../../shared/utils/credentials-schemas'
import {
  requireCredentialsEnabled,
  requireKdfStrength,
  scryptProofHasher,
} from '../../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../../utils/credentials-limits'
import { completePasswordReset } from '../../../../utils/credentials-reset'

const bodySchema = credentialsNewPasswordSchema.extend({ token: credentialsTokenSchema })

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.resetConfirm)
  const body = await readValidatedBody(event, bodySchema.parse)
  requireKdfStrength(options, body.iterations)

  const result = await completePasswordReset(db, scryptProofHasher, body.token, body)
  if (!result.ok) {
    throw createError({
      statusCode: 400,
      message: 'That link cannot be used',
      data: { code: `link_${result.reason}` },
    })
  }

  // Issued after the watermark was written, in the same second or later, so
  // this session is the one that survives the reset.
  const { user } = result
  await establishSession(event, {
    profile: {
      provider: 'credentials',
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
    emailVerified: true,
    attribution: null,
  })
  return { ok: true, user: { id: user.id } }
})
