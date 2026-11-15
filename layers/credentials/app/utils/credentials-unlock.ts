// The client hook: how an app receives the keys this layer derives but never uses.
//
//   // app/plugins/keys.client.ts in a fork
//   export default defineNuxtPlugin((nuxtApp) => {
//     nuxtApp.hook('credentials:unlock', async ({ reason, userId, unlockKey, passkey }) => { … })
//   })
//
// It is awaited, so the composable that fired it (and the navigation after it)
// waits for the app to finish. An app with no listener gets plain sign-in.

import type { HookResult } from '@nuxt/schema'

import type { PrfStatus } from './passkey-ceremony'

export type CredentialsUnlockReason =
  | 'sign-up'
  | 'sign-in'
  | 'unlock'
  | 'password-change'
  | 'password-reset'
  | 'passkey-sign-in'
  | 'passkey-register'

export interface CredentialsPasskeyUnlock {
  /** The WebAuthn credential id (base64url): which passkey this output belongs to. */
  credentialId: string
  /** 32 bytes from the PRF extension, or null when `prfStatus` is not `provided`. */
  prf: Uint8Array | null
  /**
   * `provided`       the authenticator evaluated PRF.
   * `unavailable`    it was asked and returned nothing: fall back to the password.
   * `not-requested`  PRF is off (`public.credentials.prf`) or was not asked for.
   */
  prfStatus: PrfStatus
}

export interface CredentialsUnlock {
  reason: CredentialsUnlockReason
  userId: string
  /** 32 bytes derived from the password just typed. Null on a passkey ceremony. */
  unlockKey: Uint8Array | null
  /** `password-change` only: what the old password derived, to re-wrap under the new key. */
  previousUnlockKey: Uint8Array | null
  /** Set on a passkey ceremony, null otherwise. */
  passkey: CredentialsPasskeyUnlock | null
}

declare module '#app' {
  interface RuntimeNuxtHooks {
    'credentials:unlock': (unlock: CredentialsUnlock) => HookResult
  }
}

/** Sugar for `useNuxtApp().hook('credentials:unlock', handler)`; returns the unregister function. */
export function onCredentialsUnlock(handler: (unlock: CredentialsUnlock) => HookResult) {
  return useNuxtApp().hook('credentials:unlock', handler)
}
