// Passkeys: add one, sign in with one, list and remove them. The ceremony is in
// app/utils/passkey-ceremony.ts; this binds it to the browser and to the
// `credentials:unlock` hook.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'

import type { CeremonyDeps, PrfResult } from '../utils/passkey-ceremony'
import {
  createAccountWithPasskey,
  registerPasskey,
  signInWithPasskey,
} from '../utils/passkey-ceremony'
import type { PasskeyDevice } from '../utils/passkey-device'
import { passkeyDevice, UNKNOWN_PASSKEY_DEVICE } from '../utils/passkey-device'

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
  /**
   * Whether a sign-up may offer a passkey instead of a password. With PRF on,
   * only where the browser does not say it lacks PRF: one that says nothing
   * (older Safari) is tried, and falls back to a password if it has none.
   */
  const canCreateAccount = ref(false)
  const device = ref<PasskeyDevice>(UNKNOWN_PASSKEY_DEVICE)
  onMounted(async () => {
    isSupported.value = browserSupportsWebAuthn()
    device.value = passkeyDevice(navigator)
    canCreateAccount.value =
      isSupported.value && (!options.prf || (await prfCapability()) !== false)
  })

  const deps = (): CeremonyDeps => ({
    // Explicit type arguments: inferring the route from a plain `string` makes
    // Nuxt 4.6's typed-route matcher recurse past TypeScript's depth limit.
    post: <T>(url: string, body: Record<string, unknown>) =>
      $fetch<T, string>(url, { method: 'POST', body }),
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

  /**
   * Finish a sign-up with a new passkey instead of a password: the mailed token
   * creates the account, and the hook gets `sign-up` with the passkey's PRF
   * output and no unlock key. With PRF on, a passkey without it throws
   * `passkey_prf_unavailable` and the link still works for a password.
   */
  async function createAccount(input: { token: string; name?: string | null }): Promise<void> {
    const result = await createAccountWithPasskey(deps(), {
      endpoint: '/api/auth/credentials/verify-passkey',
      user: { token: input.token, label: device.value.label, name: input.name ?? null },
      prf: options.prf,
      requirePrf: options.prf,
    })
    await nuxtApp.callHook('credentials:unlock', {
      reason: 'sign-up',
      userId: result.userId,
      unlockKey: null,
      previousUnlockKey: null,
      passkey: passkeyUnlock(result.credentialId, result.prf),
    })
    await refreshSession()
  }

  async function list(): Promise<PasskeyRow[]> {
    const { passkeys } = await $fetch<{ passkeys: PasskeyRow[] }>('/api/credentials/passkeys')
    return passkeys
  }

  async function remove(id: string): Promise<void> {
    await $fetch(`/api/credentials/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  return { isSupported, canCreateAccount, device, register, signIn, createAccount, list, remove }
}

/** `extension:prf` from WebAuthn's client capabilities, or null where the browser has no such list. */
async function prfCapability(): Promise<boolean | null> {
  const ask = (
    PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>
    }
  ).getClientCapabilities
  if (!ask) return null
  try {
    return (await ask())['extension:prf'] ?? null
  } catch {
    return null
  }
}
