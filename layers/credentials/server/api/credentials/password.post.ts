// POST /api/credentials/password — change the password. Needs the current one:
// a session left open on a shared machine must not be enough to take the account.

import { db } from '@nuxthub/db'

import { buildSessionPayload } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import { findUserById } from '#server/utils/users'
import {
  credentialsNewPasswordSchema,
  credentialsProofSchema,
} from '../../../shared/utils/credentials-schemas'
import {
  requireCredentialsEnabled,
  requireKdfStrength,
  scryptProofHasher,
} from '../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../utils/credentials-limits'
import { changePassword } from '../../utils/credentials-reset'

const bodySchema = credentialsNewPasswordSchema.extend({ currentProof: credentialsProofSchema })

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  const { user } = await requireUserSession(event)
  await rateLimit(event, { ...CREDENTIALS_LIMITS.passwordChange, identifier: user.id })
  const body = await readValidatedBody(event, bodySchema.parse)
  requireKdfStrength(options, body.iterations)

  const now = Date.now()
  const result = await changePassword(db, scryptProofHasher, user.id, body.currentProof, body, now)
  if (!result.ok) {
    const wrong = result.reason === 'wrong_password'
    throw createError({
      statusCode: wrong ? 403 : 409,
      message: wrong ? 'Wrong password' : 'This account has no password',
      data: { code: result.reason },
    })
  }

  // Every other session ended with the old password. Re-issue this one from the
  // same clock reading so it is not among them (see replacePassword).
  const row = await findUserById(db, user.id)
  if (!row) throw createError({ statusCode: 404, message: 'Account not found' })
  await replaceUserSession(event, buildSessionPayload(row, now))
  return { ok: true }
})
