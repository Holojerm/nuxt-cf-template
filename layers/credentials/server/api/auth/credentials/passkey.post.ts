// POST /api/auth/credentials/passkey — sign in with a passkey, through
// nuxt-auth-utils' WebAuthn handler (two calls: options, then the assertion).
//
// Discoverable credentials only: no address is sent, so there is no
// `allowCredentials` list to tell a stranger which accounts hold a passkey.
// No Turnstile either: nothing here can be guessed and nothing is mailed.

import { db } from '@nuxthub/db'
import type { WebAuthnCredential } from '#auth-utils'

import { establishSession } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import { findUserById, isUndeliverableAddress } from '#server/utils/users'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import {
  findPasskey,
  passkeyCeremonyFailed,
  storePasskeyChallenge,
  takePasskeyChallenge,
  touchPasskey,
} from '../../../utils/credentials-passkeys'

const refuse = (code: string) =>
  createError({ statusCode: 400, message: 'That passkey cannot be used', data: { code } })

/** Where onSuccess leaves the account id for the wrapper's response. */
const SIGNED_IN_USER = 'credentialsPasskeyUser'

const authenticate = defineWebAuthnAuthenticateEventHandler({
  storeChallenge: (_event, challenge, attemptId) => storePasskeyChallenge(db, attemptId, challenge),
  async getChallenge(_event, attemptId) {
    const challenge = await takePasskeyChallenge(db, attemptId)
    if (!challenge) throw refuse('passkey_expired')
    return challenge
  },
  async getCredential(_event, credentialId) {
    const passkey = await findPasskey(db, credentialId)
    if (!passkey) throw refuse('passkey_unknown')
    return {
      id: passkey.id,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      backedUp: passkey.backedUp,
      transports: (passkey.transports ?? undefined) as WebAuthnCredential['transports'],
      userId: passkey.userId,
    }
  },
  async onSuccess(event, { credential, authenticationInfo }) {
    const user = await findUserById(db, credential.userId)
    if (!user || isUndeliverableAddress(user.email)) throw refuse('passkey_unknown')
    await touchPasskey(db, credential.id, authenticationInfo.newCounter)
    await establishSession(event, {
      profile: {
        provider: 'credentials',
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      // A passkey is registered from a session, and every session here began
      // with a proven address.
      emailVerified: true,
      attribution: null,
    })
    event.context[SIGNED_IN_USER] = user.id
  },
  onError: passkeyCeremonyFailed,
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.passkeySignIn)
  const result = await authenticate(event)
  const userId = event.context[SIGNED_IN_USER] as string | undefined
  // The first call returns the request options; only the second signs in.
  return userId ? { verified: true, user: { id: userId } } : result
})
