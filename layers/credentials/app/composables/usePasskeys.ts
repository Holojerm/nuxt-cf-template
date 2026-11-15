// Passkeys: add one, sign in with one, list and remove them. The ceremony is in
// app/utils/passkey-ceremony.ts; this binds it to the browser and to the
// `credentials:unlock` hook.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'

import type { CeremonyDeps, PrfResult } from '../utils/passkey-ceremony'
import { registerPasskey, signInWithPasskey } from '../utils/passkey-ceremony'

export interface PasskeyRow {
  id: string
  name: string
  backedUp: boolean
  prfCapable: boolean
  createdAt: string
  lastUsedAt: string | null
}

export function usePasskeys() {
  const nuxtApp = useNuxtApp()
  const options = useRuntimeConfig().public.credentials
  const { user, fetch: refreshSession } = useUserSession()

  // False during SSR and until mounted, so the buttons never flash for a
  // browser that cannot use them.
  const isSupported = ref(false)
  onMounted(() => {
    isSupported.value = browserSupportsWebAuthn()
  })

  const deps = (): CeremonyDeps => ({
    post: (url, body) => $fetch(url, { method: 'POST', body }),
    startRegistration,
    startAuthentication,
    rpId: window.location.hostname,
  })

  const passkeyUnlock = (credentialId: string, prf: PrfResult) => ({
    credentialId,
    prf: prf.output,
    prfStatus: prf.status,
  })

  /** Add a passkey to the signed-in account. `prf` defaults to `public.credentials.prf`. */
  async function register(label: string, { prf = options.prf } = {}): Promise<PrfResult> {
    const account = user.value
    if (!account) throw createError({ statusCode: 401, message: 'Not signed in' })
    const result = await registerPasskey(deps(), {
      endpoint: '/api/credentials/passkeys/register',
      user: { userName: account.email, displayName: account.name, label },
      prf,
    })
    await nuxtApp.callHook('credentials:unlock', {
      reason: 'passkey-register',
      userId: account.id,
      unlockKey: null,
      previousUnlockKey: null,
      passkey: passkeyUnlock(result.credentialId, result.prf),
    })
    return result.prf
  }

  /** Sign in with a passkey. Resolves with the PRF result, so a page can ask for the password when there is none. */
  async function signIn({ prf = options.prf } = {}): Promise<PrfResult> {
    const result = await signInWithPasskey(deps(), {
      endpoint: '/api/auth/credentials/passkey',
      prf,
    })
    await nuxtApp.callHook('credentials:unlock', {
      reason: 'passkey-sign-in',
      userId: result.userId,
      unlockKey: null,
      previousUnlockKey: null,
      passkey: passkeyUnlock(result.credentialId, result.prf),
    })
    await refreshSession()
    return result.prf
  }

  async function list(): Promise<PasskeyRow[]> {
    const { passkeys } = await $fetch<{ passkeys: PasskeyRow[] }>('/api/credentials/passkeys')
    return passkeys
  }

  async function remove(id: string): Promise<void> {
    await $fetch(`/api/credentials/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  return { isSupported, register, signIn, list, remove }
}
