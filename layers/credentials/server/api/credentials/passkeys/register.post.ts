// POST /api/credentials/passkeys/register — add a passkey to the signed-in
// account, through nuxt-auth-utils' WebAuthn handler (options, then the
// attestation). Under /api/credentials/, so the session guard has already run.

import { db } from '@nuxthub/db'
import type { WebAuthnCredential } from '#auth-utils'
import { z } from 'zod'

import { rateLimit } from '#server/utils/rate-limit'
import { credentialsPasskeyLabelSchema } from '../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import {
  listPasskeys,
  passkeyCeremonyFailed,
  savePasskey,
  storePasskeyChallenge,
  takePasskeyChallenge,
} from '../../../utils/credentials-passkeys'

const userSchema = z.object({
  userName: z.string().min(1).max(254),
  displayName: z.string().max(100).optional(),
  label: credentialsPasskeyLabelSchema,
  /** What the browser saw the authenticator report. Display only. */
  prfCapable: z.boolean().default(false),
})

const register = defineWebAuthnRegisterEventHandler({
  // The handler takes the account from the request body; the session decides.
  async validateUser(body, event) {
    const { user } = await requireUserSession(event)
    const parsed = userSchema.parse(body)
    if (parsed.userName !== user.email) {
      throw createError({ statusCode: 403, message: 'Not your account' })
    }
    return parsed
  },
  storeChallenge: (_event, challenge, attemptId) => storePasskeyChallenge(db, attemptId, challenge),
  async getChallenge(_event, attemptId) {
    const challenge = await takePasskeyChallenge(db, attemptId)
    if (!challenge) {
      throw createError({
        statusCode: 400,
        message: 'That took too long. Try again.',
        data: { code: 'passkey_expired' },
      })
    }
    return challenge
  },
  getOptions: (event) => ({
    rpName: useRuntimeConfig(event).public.appName,
    // Discoverable, so sign-in needs no address typed first.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  }),
  async excludeCredentials(event) {
    const { user } = await requireUserSession(event)
    const passkeys = await listPasskeys(db, user.id)
    return passkeys.map((passkey) => ({
      id: passkey.id,
      transports: (passkey.transports ?? undefined) as WebAuthnCredential['transports'],
    }))
  },
  async onSuccess(event, { user, credential }) {
    const session = await requireUserSession(event)
    const saved = await savePasskey(db, session.user.id, credential, {
      name: user.label,
      prfCapable: user.prfCapable,
    })
    if (saved === 'limit_reached') {
      throw createError({
        statusCode: 409,
        message: 'Remove a passkey before adding another',
        data: { code: 'passkey_limit' },
      })
    }
  },
  onError: passkeyCeremonyFailed,
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.passkeyRegister)
  return register(event)
})
