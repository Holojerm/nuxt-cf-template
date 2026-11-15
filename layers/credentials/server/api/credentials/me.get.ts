// GET /api/credentials/me — how the signed-in account signs in: whether it has
// a password, and the parameters its browser derives with.

import { db } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

import { rateLimit } from '#server/utils/rate-limit'
import { credentialPasswords } from '../../db/schema'
import { requireCredentialsEnabled } from '../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../utils/credentials-limits'

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.overview)
  const { user } = await requireUserSession(event)
  const password = await db.query.credentialPasswords.findFirst({
    where: eq(credentialPasswords.userId, user.id),
    columns: { salt: true, iterations: true, updatedAt: true },
  })
  return {
    hasPassword: Boolean(password),
    kdf: password ? { salt: password.salt, iterations: password.iterations } : null,
    passwordChangedAt: password?.updatedAt.toISOString() ?? null,
    /** What a new password must be derived with. */
    iterations: options.iterations,
  }
})
