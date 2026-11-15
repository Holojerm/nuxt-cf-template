// POST /api/auth/credentials/verify — finish a sign-up: spend the mailed token,
// take the password chosen on the page the link opened, create the account (or
// give an existing one its first password) and sign in.
//
// POST, behind a form: mail gateways fetch every URL in a message, so a GET
// that verified would let the scanner finish the sign-up.

import { db } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { users } from '#server/db/schema'
import { establishSession } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import {
  credentialsNewPasswordSchema,
  credentialsTokenSchema,
} from '../../../../shared/utils/credentials-schemas'
import {
  requireCredentialsEnabled,
  requireKdfStrength,
  scryptProofHasher,
} from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { hashNewPassword, passwordUpsert } from '../../../utils/credentials-password'
import { redeemSignUp } from '../../../utils/credentials-signup'

const bodySchema = credentialsNewPasswordSchema.extend({
  token: credentialsTokenSchema,
  name: z.string().trim().min(1).max(100).nullish(),
})

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.verify)
  const body = await readValidatedBody(event, bodySchema.parse)
  requireKdfStrength(options, body.iterations)

  // Hashed before the token is spent: a failure here must not cost the link.
  const password = await hashNewPassword(scryptProofHasher, body)

  const redeemed = await redeemSignUp(db, body.token)
  if (!redeemed.ok) {
    const code =
      redeemed.reason === 'already_registered' ? redeemed.reason : `link_${redeemed.reason}`
    throw createError({ statusCode: 400, message: 'That link cannot be used', data: { code } })
  }
  const { pending } = redeemed

  // An account that arrived by another sign-in method keeps the name it has.
  const existing = await db.query.users.findFirst({
    where: eq(users.email, pending.email),
    columns: { name: true, avatarUrl: true },
  })
  const { user, created } = await establishSession(event, {
    profile: {
      provider: 'credentials',
      email: pending.email,
      name: body.name ?? existing?.name ?? null,
      avatarUrl: existing?.avatarUrl ?? null,
    },
    // Our own evidence: the token was mailed to this address and came back.
    emailVerified: true,
    attribution: pending.attribution,
  })
  await passwordUpsert(db, user.id, password)

  return { ok: true, created, user: { id: user.id } }
})
