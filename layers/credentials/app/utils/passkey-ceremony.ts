// The browser half of a passkey ceremony, with PRF.
//
// nuxt-auth-utils' `useWebAuthn()` runs the same two round trips but returns
// only a boolean: the authenticator's extension results never leave it, and
// @simplewebauthn/browser passes `extensions` through untouched, so a
// base64url PRF input from the server would reach the authenticator as a
// string. So this calls @simplewebauthn/browser itself, adds the PRF input as
// bytes on the way in, and reads the output on the way out.
//
// Two rules: the PRF output is removed from the response before it is posted
// (the server verifies the assertion and never needs it), and everything the
// ceremony touches is passed in, so the tests drive it with a fake authenticator.

import { credentialsBase64url } from '../../shared/utils/credentials-kdf'

/** The PRF input. Fixed: a passkey must return the same secret on every sign-in. */
export const PASSKEY_PRF_INPUT: Uint8Array = new TextEncoder().encode('credentials/v1/passkey-prf')

export type PrfStatus = 'provided' | 'unavailable' | 'not-requested'

export interface PrfResult {
  status: PrfStatus
  output: Uint8Array | null
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } }
  [extension: string]: unknown
}

/** The parts of a @simplewebauthn/browser response this module reads. */
export interface CeremonyResponse {
  id: string
  response: { transports?: string[] }
  clientExtensionResults?: PrfExtensionResults
  [field: string]: unknown
}

type CeremonyOptions = Record<string, unknown> & { extensions?: Record<string, unknown> }

export interface CeremonyDeps {
  post: <T>(url: string, body: Record<string, unknown>) => Promise<T>
  startRegistration: (input: { optionsJSON: never }) => Promise<unknown>
  startAuthentication: (input: { optionsJSON: never }) => Promise<unknown>
  /** The relying-party id for a ceremony that never reaches the server (evaluatePrf). */
  rpId: string
}

const NOT_REQUESTED: PrfResult = { status: 'not-requested', output: null }
const UNAVAILABLE: PrfResult = { status: 'unavailable', output: null }

function withPrf<T extends CeremonyOptions>(options: T): T {
  return {
    ...options,
    extensions: { ...options.extensions, prf: { eval: { first: PASSKEY_PRF_INPUT } } },
  }
}

export function readPrf(results: PrfExtensionResults | undefined, requested: boolean): PrfResult {
  if (!requested) return NOT_REQUESTED
  const first = results?.prf?.results?.first
  if (!first) return UNAVAILABLE
  const bytes = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first)
  // A copy, so the caller's key does not alias the browser's buffer.
  return { status: 'provided', output: bytes.slice() }
}

/** The response as the server may see it: everything but the PRF output. */
export function withoutPrf<T extends CeremonyResponse>(response: T): T {
  const { prf: _secret, ...rest } = response.clientExtensionResults ?? {}
  return { ...response, clientExtensionResults: rest }
}

const run = (
  start: CeremonyDeps['startRegistration'],
  options: CeremonyOptions,
): Promise<CeremonyResponse> =>
  start({ optionsJSON: options as never }) as Promise<CeremonyResponse>

function randomChallenge(): string {
  return credentialsBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Ask one passkey for its PRF output without signing in: an assertion over a
 * challenge made here, verified by nobody and sent nowhere. For an
 * authenticator that enables PRF at registration but only evaluates it on use.
 */
export async function evaluatePrf(
  deps: CeremonyDeps,
  credential: { id: string; transports?: string[] },
): Promise<PrfResult> {
  try {
    const response = await run(
      deps.startAuthentication,
      withPrf({
        challenge: randomChallenge(),
        rpId: deps.rpId,
        allowCredentials: [
          { id: credential.id, type: 'public-key', transports: credential.transports },
        ],
        userVerification: 'preferred',
      }),
    )
    return readPrf(response.clientExtensionResults, true)
  } catch {
    // Dismissed, or the authenticator refused: the passkey still signs in.
    return UNAVAILABLE
  }
}

export interface RegisterPasskeyInput {
  endpoint: string
  user: { userName: string; displayName?: string; label: string }
  prf: boolean
}

export interface PasskeyCeremonyResult {
  credentialId: string
  prf: PrfResult
}

export async function registerPasskey(
  deps: CeremonyDeps,
  { endpoint, user, prf }: RegisterPasskeyInput,
): Promise<PasskeyCeremonyResult> {
  const { creationOptions, attemptId } = await deps.post<{
    creationOptions: CeremonyOptions
    attemptId: string
  }>(endpoint, { user: { ...user, prfCapable: false }, verify: false })

  const response = await run(
    deps.startRegistration,
    prf ? withPrf(creationOptions) : creationOptions,
  )
  let result = readPrf(response.clientExtensionResults, prf)
  const capable =
    prf && (result.status === 'provided' || response.clientExtensionResults?.prf?.enabled === true)

  await deps.post(endpoint, {
    user: { ...user, prfCapable: capable },
    attemptId,
    response: withoutPrf(response),
    verify: true,
  })

  if (capable && result.status !== 'provided') {
    result = await evaluatePrf(deps, {
      id: response.id,
      transports: response.response.transports,
    })
  }
  return { credentialId: response.id, prf: result }
}

export interface SignInWithPasskeyResult extends PasskeyCeremonyResult {
  userId: string
}

export async function signInWithPasskey(
  deps: CeremonyDeps,
  { endpoint, prf }: { endpoint: string; prf: boolean },
): Promise<SignInWithPasskeyResult> {
  const { requestOptions, attemptId } = await deps.post<{
    requestOptions: CeremonyOptions
    attemptId: string
  }>(endpoint, { verify: false })

  const response = await run(
    deps.startAuthentication,
    prf ? withPrf(requestOptions) : requestOptions,
  )
  const { user } = await deps.post<{ user: { id: string } }>(endpoint, {
    attemptId,
    response: withoutPrf(response),
    verify: true,
  })
  return {
    userId: user.id,
    credentialId: response.id,
    prf: readPrf(response.clientExtensionResults, prf),
  }
}
