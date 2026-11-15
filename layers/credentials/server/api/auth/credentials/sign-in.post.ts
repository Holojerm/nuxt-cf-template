// POST /api/auth/credentials/sign-in — check a browser-derived proof and issue
// the session. One answer for every failure: which half was wrong is the
// difference between guessing passwords and guessing accounts.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { establishSession } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import { requireTurnstile, turnstileTokenSchema } from '#server/utils/turnstile'
import {
  credentialsEmailSchema,
  credentialsProofSchema,
} from '../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled, scryptProofHasher } from '../../../utils/credentials-config'
import { accountLimitIdentifier, CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { verifySignInProof } from '../../../utils/credentials-password'

const bodySchema = z.object({
  email: credentialsEmailSchema,
  proof: credentialsProofSchema,
  turnstileToken: turnstileTokenSchema.nullish(),
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.signIn)
  const body = await readValidatedBody(event, bodySchema.parse)

  // Before the per-account budget, so only a solved challenge can spend it.
  await requireTurnstile(event, body.turnstileToken)
  // Charged for every address, account or not, so its 429 says nothing about one.
  await rateLimit(event, {
    ...CREDENTIALS_LIMITS.signInAccount,
    identifier: await accountLimitIdentifier(body.email),
  })

  const user = await verifySignInProof(db, scryptProofHasher, body.email, body.proof)
  if (!user) {
    throw createError({
      statusCode: 401,
      message: 'Wrong email or password',
      data: { code: 'invalid_credentials' },
    })
  }

  await establishSession(event, {
    profile: {
      provider: 'credentials',
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
    // A password row is only ever written after a mailed token came back
    // (sign-up verification or a reset), so the address is proven.
    emailVerified: true,
    attribution: null,
  })
  return { ok: true, user: { id: user.id } }
})
