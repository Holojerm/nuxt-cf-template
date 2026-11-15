// POST /api/auth/credentials/params — the salt and iteration count an address
// derives its sign-in proof with. Answers for every address, account or not
// (credentials-params.ts): this is asked before anyone has authenticated.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { rateLimit } from '#server/utils/rate-limit'
import { credentialsEmailSchema } from '../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import { lookupKdfParams } from '../../../utils/credentials-params'

const bodySchema = z.object({ email: credentialsEmailSchema })

export default defineEventHandler(async (event) => {
  const options = requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.params)
  const { email } = await readValidatedBody(event, bodySchema.parse)
  return lookupKdfParams(db, email, options.iterations)
})
