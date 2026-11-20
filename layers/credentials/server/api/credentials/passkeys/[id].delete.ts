// DELETE /api/credentials/passkeys/:id — remove one of the signed-in account's
// passkeys. The id is in the path: Workers drop a DELETE body.

import { db } from '@nuxthub/db'

import { rateLimit } from '#server/utils/rate-limit'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { removePasskey } from '../../../utils/credentials-passkeys'

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.passkeyManage)
  const { user } = await requireUserSession(event)
  const id = getRouterParam(event, 'id') ?? ''
  // Where this layer is the only sign-in, the last passkey of an account with no password stays.
  const result = await removePasskey(db, user.id, id, { keepOne: options.primary })
  if (result === 'not_found') {
    throw createError({ statusCode: 404, message: 'Passkey not found' })
  }
  if (result === 'last_way_in') {
    throw createError({
      statusCode: 409,
      message: 'Set a password before removing your only passkey',
      data: { code: 'passkey_last' },
    })
  }
  return { removed: true }
})
