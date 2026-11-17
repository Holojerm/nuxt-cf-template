// Every budget the layer's routes charge, in one place so a test can prove each
// route names one. None of them equals core's NATIVE_LIMITER (30 per 60s), on
// purpose: they are counted in D1 only, where a 15-minute window is possible
// and the count is exact.

import { canonicalizeEmailForLimiting } from '#server/utils/users'
import { sha256Hex } from '#server/utils/hash'

export interface CredentialsLimit {
  name: string
  limit: number
  windowSeconds: number
}

export const CREDENTIALS_LIMITS = {
  params: { name: 'credentials-params', limit: 20, windowSeconds: 60 },
  signIn: { name: 'credentials-sign-in', limit: 10, windowSeconds: 60 },
  /** Per mailbox, whoever is asking: what bounds guessing one account from many addresses. */
  signInAccount: { name: 'credentials-sign-in-account', limit: 10, windowSeconds: 900 },
  signUp: { name: 'credentials-sign-up', limit: 5, windowSeconds: 60 },
  verify: { name: 'credentials-verify', limit: 10, windowSeconds: 60 },
  resetRequest: { name: 'credentials-reset-request', limit: 5, windowSeconds: 60 },
  resetConfirm: { name: 'credentials-reset-confirm', limit: 10, windowSeconds: 60 },
  passkeySignIn: { name: 'credentials-passkey-sign-in', limit: 20, windowSeconds: 60 },
  passkeyRegister: { name: 'credentials-passkey-register', limit: 10, windowSeconds: 60 },
  passkeyManage: { name: 'credentials-passkey-manage', limit: 20, windowSeconds: 60 },
  passwordChange: { name: 'credentials-password-change', limit: 5, windowSeconds: 60 },
  unlock: { name: 'credentials-unlock', limit: 10, windowSeconds: 60 },
  overview: { name: 'credentials-overview', limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, CredentialsLimit>

/**
 * Mail this layer may send one mailbox, counted in D1 from `credential_tokens`
 * rows (credentials-tokens.ts) rather than by `rateLimit()`: a KV window is
 * get-then-set and lets parallel requests through, and its 429 would tell a
 * stranger that somebody is mid-reset at that address.
 */
export const CREDENTIALS_MAIL_BUDGET = { limit: 5, windowSeconds: 15 * 60 }

/**
 * The `identifier` for a per-account `rateLimit()`. Hashed so no address is
 * written into a KV key, and canonicalised so `ada+1@gmail.com` and
 * `a.d.a@gmail.com` share the bucket of the account they both reach.
 */
export function accountLimitIdentifier(email: string): Promise<string> {
  return sha256Hex(`credentials-account:${canonicalizeEmailForLimiting(email)}`)
}
