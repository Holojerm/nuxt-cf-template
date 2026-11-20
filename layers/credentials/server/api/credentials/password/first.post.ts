// POST /api/credentials/password/first — give an account that signs in only
// with a passkey its first password, from its session.
//
// No current password to ask for, and no mail: a session can already add a
// passkey (passkeys/register.post.ts), and a password grants nothing a passkey
// does not. Replacing a password that exists stays behind the old one or a
// mailed token.

import { db } from '@nuxthub/db'

import { rateLimit } from '#server/utils/rate-limit'
import { credentialsNewPasswordSchema } from '../../../../shared/utils/credentials-schemas'
import {
  requireCredentialsEnabled,
  requireKdfStrength,
  scryptProofHasher,
} from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { hashNewPassword, setFirstPassword } from '../../../utils/credentials-password'

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  const { user } = await requireUserSession(event)
  await rateLimit(event, { ...CREDENTIALS_LIMITS.passwordChange, identifier: user.id })
  const body = await readValidatedBody(event, credentialsNewPasswordSchema.parse)
  requireKdfStrength(options, body.iterations)

  const stored = await hashNewPassword(scryptProofHasher, body)
  if (!(await setFirstPassword(db, user.id, stored))) {
    throw createError({
      statusCode: 409,
      message: 'This account already has a password',
      data: { code: 'password_exists' },
    })
  }
  return { ok: true }
})
