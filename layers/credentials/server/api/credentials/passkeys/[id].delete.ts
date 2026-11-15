// DELETE /api/credentials/passkeys/:id — remove one of the signed-in account's
// passkeys. The id is in the path: Workers drop a DELETE body.

import { db } from '@nuxthub/db'

import { rateLimit } from '#server/utils/rate-limit'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { removePasskey } from '../../../utils/credentials-passkeys'

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.passkeyManage)
  const { user } = await requireUserSession(event)
  const id = getRouterParam(event, 'id') ?? ''
  if (!(await removePasskey(db, user.id, id))) {
    throw createError({ statusCode: 404, message: 'Passkey not found' })
  }
  return { removed: true }
})
