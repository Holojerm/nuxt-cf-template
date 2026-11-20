// POST /api/auth/credentials/verify-passkey — finish a sign-up with a passkey
// instead of a password: the same mailed token as /verify, spent by the second
// of nuxt-auth-utils' two WebAuthn calls (options, then the attestation).
//
// The first call only reads the token, to learn the address the passkey is
// made for; the second spends it, creates the account, saves the passkey and
// signs in. A browser that gives up between the two (no PRF, a dismissed
// prompt) leaves the link usable for a password.

import { db } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { createError } from 'nuxt/server'
import { z } from 'zod'

import { users } from '#server/db/schema'
import { establishSession } from '#server/utils/auth'
import { rateLimit } from '#server/utils/rate-limit'
import { h3Event, requestEvent } from '#server/utils/request-event'
import {
  credentialsPasskeyLabelSchema,
  credentialsTokenSchema,
} from '../../../../shared/utils/credentials-schemas'
import { requireCredentialsEnabled } from '../../../utils/credentials-config'
import { CREDENTIALS_LIMITS } from '../../../utils/credentials-limits'
import {
  passkeyCeremonyFailed,
  savePasskey,
  storePasskeyChallenge,
  takePasskeyChallenge,
} from '../../../utils/credentials-passkeys'
import { peekSignUp, redeemSignUp } from '../../../utils/credentials-signup'
import type { RedeemSignUpResult } from '../../../utils/credentials-signup'

const userSchema = z.object({
  token: credentialsTokenSchema,
  label: credentialsPasskeyLabelSchema,
  name: z.string().trim().min(1).max(100).nullish(),
  /** What the browser saw the authenticator report. Display only. */
  prfCapable: z.boolean().default(false),
})
const bodySchema = z.object({ verify: z.boolean(), user: userSchema }).passthrough()

type SignUpUser = z.infer<typeof userSchema> & { userName: string; displayName?: string }

/** Where the wrapper leaves the address for validateUser, and onSuccess the new account. */
const PENDING_EMAIL = 'credentialsSignUpEmail'
const SIGNED_UP = 'credentialsSignUpUser'

function refuseLink(result: Extract<RedeemSignUpResult, { ok: false }>): never {
  const code = result.reason === 'already_registered' ? result.reason : `link_${result.reason}`
  throw createError({ status: 400, message: 'That link cannot be used', data: { code } })
}

const register = defineWebAuthnRegisterEventHandler<SignUpUser>({
  // The handler names the passkey after `userName`; the token decides it.
  validateUser(body, event) {
    const email = h3Event(event).context[PENDING_EMAIL] as string | undefined
    const user = userSchema.parse(body)
    return { ...user, userName: email ?? 'new-account', displayName: user.name ?? undefined }
  },
  storeChallenge: (_event, challenge, attemptId) => storePasskeyChallenge(db, attemptId, challenge),
  async getChallenge(_event, attemptId) {
    const challenge = await takePasskeyChallenge(db, attemptId)
    if (!challenge) {
      throw createError({
        status: 400,
        message: 'That took too long. Try again.',
        data: { code: 'passkey_expired' },
      })
    }
    return challenge
  },
  getOptions: (event) => ({
    rpName: useRuntimeConfig(h3Event(event)).public.appName,
    // Discoverable, so sign-in needs no address typed first.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  }),
  async onSuccess(event, { user, credential }) {
    const redeemed = await redeemSignUp(db, user.token)
    if (!redeemed.ok) refuseLink(redeemed)
    const { pending } = redeemed

    const existing = await db.query.users.findFirst({
      where: eq(users.email, pending.email),
      columns: { name: true, avatarUrl: true },
    })
    const { user: account, created } = await establishSession(h3Event(event), {
      profile: {
        provider: 'credentials',
        email: pending.email,
        name: user.name ?? existing?.name ?? null,
        avatarUrl: existing?.avatarUrl ?? null,
      },
      // Our own evidence: the token was mailed to this address and came back.
      emailVerified: true,
      attribution: pending.attribution,
    })
    // A new account has no passkeys, so the per-account ceiling cannot be reached.
    await savePasskey(db, account.id, credential, {
      name: user.label,
      prfCapable: user.prfCapable,
    })
    h3Event(event).context[SIGNED_UP] = { id: account.id, created }
  },
  onError: passkeyCeremonyFailed,
})

export default defineEventHandler(async (event) => {
  requireCredentialsEnabled(event)
  await rateLimit(event, CREDENTIALS_LIMITS.verify)
  const body = await readValidatedBody(event, bodySchema.parse)
  if (!body.verify) {
    // Refused before the authenticator is asked, so nobody makes a passkey for a dead link.
    const peeked = await peekSignUp(db, body.user.token)
    if (!peeked.ok) refuseLink(peeked)
    event.context[PENDING_EMAIL] = peeked.pending.email
  }
  const result = await register(requestEvent(event))
  const signedUp = event.context[SIGNED_UP] as { id: string; created: boolean } | undefined
  return signedUp ? { ok: true, created: signedUp.created, user: { id: signedUp.id } } : result
})
