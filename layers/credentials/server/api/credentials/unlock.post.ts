// POST /api/credentials/unlock — is this the account's password? Changes
// nothing. The browser asks before handing the unlock key it derived to the
// app, so a typo is caught here instead of failing to decrypt something later.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { rateLimit } from '#server/utils/rate-limit'
import { credentialsProofSchema } from '../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled, scryptProofHasher } from '../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../utils/credentials-limits'
import { verifyProofForUser } from '../../utils/credentials-password'

const bodySchema = z.object({ proof: credentialsProofSchema })

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  const { user } = await requireUserSession(event)
  // Per account: the session is known here, and it is the account being guessed at.
  await rateLimit(event, { ...CREDENTIALS_LIMITS.unlock, identifier: user.id })
  const { proof } = await readValidatedBody(event, bodySchema.parse)

  const verdict = await verifyProofForUser(db, scryptProofHasher, user.id, proof)
  if (verdict !== 'ok') {
    // 403, not 401: the session is fine, and a 401 reads as "signed out".
    throw createError({
      statusCode: verdict === 'wrong' ? 403 : 409,
      message: verdict === 'wrong' ? 'Wrong password' : 'This account has no password',
      data: { code: verdict === 'wrong' ? 'wrong_password' : 'no_password' },
    })
  }
  return { ok: true }
})
