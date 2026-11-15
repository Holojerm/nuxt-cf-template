// GET /api/credentials/passkeys — the signed-in account's passkeys.

import { db } from '@nuxthub/db'

import { rateLimit } from '#server/utils/rate-limit'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { listPasskeys, passkeySummary } from '../../../utils/credentials-passkeys'

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.passkeyManage)
  const { user } = await requireUserSession(event)
  const passkeys = await listPasskeys(db, user.id)
  return { passkeys: passkeys.map(passkeySummary) }
})
