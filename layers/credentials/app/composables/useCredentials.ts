// Password sign-up, sign-in, unlock, change and reset.
//
// Everything that touches a password happens here, in the browser: the proof
// is derived and sent, the unlock key is derived and handed to the app's
// `credentials:unlock` hook (app/utils/credentials-unlock.ts), and the
// password itself goes nowhere.
//
// The hook fires after the server accepted the proof and BEFORE the reactive
// session refreshes: the cookie is already set, so the app's listener can call
// its own API, and a page that redirects on `loggedIn` waits for the listener.

import type { CredentialsUnlock } from '../utils/credentials-unlock'

interface KdfAnswer {
  salt: string
  iterations: number
}

interface SignedIn {
  user: { id: string }
}

interface LinkAnswer {
  ok: boolean
  /** Dev only, with no mail provider configured: the link that would have been mailed. */
  devLink?: string
}

const post = <T>(url: string, body: Record<string, unknown>) =>
  $fetch<T>(url, { method: 'POST', body })

export function useCredentials() {
  const nuxtApp = useNuxtApp()
  const options = useRuntimeConfig().public.credentials
  const { user, fetch: refreshSession } = useUserSession()

  const newKdf = (): KdfAnswer => ({ salt: generateKdfSalt(), iterations: options.iterations })

  async function finish(unlock: CredentialsUnlock): Promise<void> {
    await nuxtApp.callHook('credentials:unlock', unlock)
    await refreshSession()
  }

  /** The signed-in account's own parameters, for a password typed after sign-in. */
  async function ownKdf(): Promise<KdfAnswer> {
    const me = await $fetch<{ kdf: KdfAnswer | null }>('/api/credentials/me')
    // The shape authErrorCode() reads off a failed $fetch, so pages phrase it the same way.
    if (!me.kdf)
      throw Object.assign(new Error('no_password'), { data: { data: { code: 'no_password' } } })
    return me.kdf
  }

  function requireUserId(): string {
    const id = user.value?.id
    if (!id) throw createError({ statusCode: 401, message: 'Not signed in' })
    return id
  }

  /** Start a sign-up: mail the address a link. The password is chosen when the link is opened. */
  function signUp(input: { email: string; turnstileToken?: string | null }): Promise<LinkAnswer> {
    return post<LinkAnswer>('/api/auth/credentials/sign-up', {
      email: input.email,
      turnstileToken: input.turnstileToken || null,
    })
  }

  /** Finish a sign-up with the mailed token and the password chosen now. Creates the account and signs in. */
  async function completeSignUp(input: {
    token: string
    password: string
    name?: string
  }): Promise<void> {
    const kdf = newKdf()
    const { proof, unlockKey } = await deriveCredentials(input.password, kdf)
    const { user: signedIn } = await post<SignedIn>('/api/auth/credentials/verify', {
      token: input.token,
      name: input.name || null,
      ...kdf,
      proof,
    })
    await finish({
      reason: 'sign-up',
      userId: signedIn.id,
      unlockKey,
      previousUnlockKey: null,
      passkey: null,
    })
  }

  async function signIn(input: {
    email: string
    password: string
    turnstileToken?: string | null
  }): Promise<void> {
    const kdf = await post<KdfAnswer>('/api/auth/credentials/params', { email: input.email })
    const { proof, unlockKey } = await deriveCredentials(input.password, kdf)
    const { user: signedIn } = await post<SignedIn>('/api/auth/credentials/sign-in', {
      email: input.email,
      proof,
      turnstileToken: input.turnstileToken || null,
    })
    await finish({
      reason: 'sign-in',
      userId: signedIn.id,
      unlockKey,
      previousUnlockKey: null,
      passkey: null,
    })
  }

  /**
   * Derive the unlock key for someone already signed in, who arrived without
   * typing a password: a passkey with no PRF. The server confirms the password
   * first, so a typo never reaches the hook.
   */
  async function unlock(password: string): Promise<void> {
    const userId = requireUserId()
    const { proof, unlockKey } = await deriveCredentials(password, await ownKdf())
    await post('/api/credentials/unlock', { proof })
    await finish({ reason: 'unlock', userId, unlockKey, previousUnlockKey: null, passkey: null })
  }

  async function changePassword(input: {
    currentPassword: string
    newPassword: string
  }): Promise<void> {
    const userId = requireUserId()
    const kdf = newKdf()
    const [current, next] = await Promise.all([
      deriveCredentials(input.currentPassword, await ownKdf()),
      deriveCredentials(input.newPassword, kdf),
    ])
    await post('/api/credentials/password', {
      currentProof: current.proof,
      ...kdf,
      proof: next.proof,
    })
    await finish({
      reason: 'password-change',
      userId,
      unlockKey: next.unlockKey,
      previousUnlockKey: current.unlockKey,
      passkey: null,
    })
  }

  function requestReset(input: {
    email: string
    turnstileToken?: string | null
  }): Promise<LinkAnswer> {
    return post<LinkAnswer>('/api/auth/credentials/reset/request', {
      email: input.email,
      turnstileToken: input.turnstileToken || null,
    })
  }

  /** Set a new password with a mailed token. The old unlock key is gone: none is passed on. */
  async function completeReset(input: { token: string; password: string }): Promise<void> {
    const kdf = newKdf()
    const { proof, unlockKey } = await deriveCredentials(input.password, kdf)
    const { user: signedIn } = await post<SignedIn>('/api/auth/credentials/reset/confirm', {
      token: input.token,
      ...kdf,
      proof,
    })
    await finish({
      reason: 'password-reset',
      userId: signedIn.id,
      unlockKey,
      previousUnlockKey: null,
      passkey: null,
    })
  }

  /**
   * A first password for an account that signs in only with a passkey. Fires
   * `password-set` with the new unlock key, so the app can wrap what this
   * device already holds.
   */
  async function setPassword(password: string): Promise<void> {
    const userId = requireUserId()
    const kdf = newKdf()
    const { proof, unlockKey } = await deriveCredentials(password, kdf)
    await post('/api/credentials/password/first', { ...kdf, proof })
    await finish({
      reason: 'password-set',
      userId,
      unlockKey,
      previousUnlockKey: null,
      passkey: null,
    })
  }

  return {
    signUp,
    completeSignUp,
    signIn,
    unlock,
    changePassword,
    setPassword,
    requestReset,
    completeReset,
  }
}
