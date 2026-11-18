// Passkeys end to end with a software authenticator: the browser ceremony
// (app/utils/passkey-ceremony.ts) on one side, and on the other the same
// @simplewebauthn/server calls nuxt-auth-utils' handlers make, wired to this
// layer's storage in real D1. The handlers themselves need Nitro, so `server`
// below repeats their two-call protocol around the real verification.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { createError as h3CreateError } from 'h3'
import { createError, isNuxtError } from 'nuxt/server'
import type { NuxtError, RequestEvent } from 'nuxt/server'
import { beforeEach, describe, expect, it } from 'vitest'

import type { CeremonyDeps } from '../app/utils/passkey-ceremony'
import {
  PASSKEY_PRF_INPUT,
  registerPasskey,
  signInWithPasskey,
} from '../app/utils/passkey-ceremony'
import { credentialsBase64url, credentialsFromBase64url } from '../shared/utils/credentials-kdf'
import {
  findPasskey,
  listPasskeys,
  MAX_PASSKEYS_PER_USER,
  passkeyCeremonyFailed,
  passkeySummary,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  removePasskey,
  savePasskey,
  storePasskeyChallenge,
  takePasskeyChallenge,
  touchPasskey,
} from '../server/utils/credentials-passkeys'
import { addUser, db, resetCredentialTables } from './lib/fixtures'
import { createSoftAuthenticator } from './lib/soft-authenticator'
import type { PrfSupport, SoftAuthenticator } from './lib/soft-authenticator'

const ORIGIN = 'https://app.example'
const RP_ID = 'app.example'
const REGISTER = '/api/credentials/passkeys/register'
const SIGN_IN = '/api/auth/credentials/passkey'
const USER = { userName: 'ada@example.com', displayName: 'Ada', label: 'MacBook' }

type Body = Record<string, any>

/** The relying party, and a record of every body the browser posted to it. */
function server() {
  const posted: Body[] = []
  let attempt = 0
  async function post<T>(url: string, body: Body): Promise<T> {
    posted.push(body)
    if (!body.verify) {
      const options =
        url === REGISTER
          ? await generateRegistrationOptions({
              rpID: RP_ID,
              rpName: 'App',
              userName: body.user.userName,
              authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
            })
          : await generateAuthenticationOptions({ rpID: RP_ID })
      const attemptId = `attempt-${++attempt}`
      await storePasskeyChallenge(db, attemptId, options.challenge)
      const key = url === REGISTER ? 'creationOptions' : 'requestOptions'
      return { [key]: options, attemptId } as T
    }

    const expectedChallenge = await takePasskeyChallenge(db, body.attemptId)
    if (!expectedChallenge) throw new Error('challenge expired or already used')
    const expected = { expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID }

    if (url === REGISTER) {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response: body.response,
        ...expected,
        requireUserVerification: false,
      })
      if (!verified || !registrationInfo) throw new Error('registration not verified')
      await savePasskey(
        db,
        'u1',
        {
          id: registrationInfo.credential.id,
          publicKey: credentialsBase64url(registrationInfo.credential.publicKey),
          counter: registrationInfo.credential.counter,
          backedUp: registrationInfo.credentialBackedUp,
          transports: registrationInfo.credential.transports,
          aaguid: registrationInfo.aaguid,
        },
        { name: body.user.label, prfCapable: body.user.prfCapable },
      )
      return { verified } as T
    }

    const passkey = await findPasskey(db, body.response.id)
    if (!passkey) throw new Error('unknown passkey')
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: body.response,
      ...expected,
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: credentialsFromBase64url(passkey.publicKey),
        counter: passkey.counter,
      },
    })
    if (!verified) throw new Error('assertion not verified')
    await touchPasskey(db, passkey.id, authenticationInfo.newCounter)
    return { verified, user: { id: passkey.userId } } as T
  }
  return { post, posted }
}

async function setup(prf: PrfSupport) {
  const authenticator = await createSoftAuthenticator({ origin: ORIGIN, rpId: RP_ID, prf })
  const relyingParty = server()
  const deps: CeremonyDeps = {
    post: relyingParty.post,
    startRegistration: authenticator.startRegistration,
    startAuthentication: authenticator.startAuthentication,
    rpId: RP_ID,
  }
  return { authenticator, deps, posted: relyingParty.posted }
}

/** Nothing the browser posted may carry a PRF result. */
function expectNoPrfPosted(posted: Body[], authenticator: SoftAuthenticator) {
  expect(authenticator.seen.length).toBeGreaterThan(0)
  for (const body of posted) {
    expect(body.response?.clientExtensionResults?.prf).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('"results"')
  }
}

beforeEach(async () => {
  await resetCredentialTables()
  await addUser('u1', 'ada@example.com')
})

describe('register, then sign in', () => {
  it('stores a credential the server can verify an assertion against', async () => {
    const { deps, authenticator } = await setup('none')
    const registered = await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: false })
    expect(registered.credentialId).toBe(authenticator.credentialId)

    const [stored] = await listPasskeys(db, 'u1')
    expect(stored).toMatchObject({ id: authenticator.credentialId, name: 'MacBook', counter: 0 })

    const signedIn = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: false })
    expect(signedIn).toMatchObject({ userId: 'u1', credentialId: authenticator.credentialId })

    const after = (await findPasskey(db, authenticator.credentialId))!
    expect(after.counter).toBe(1)
    expect(after.lastUsedAt).not.toBeNull()
  })

  it('refuses an assertion from an authenticator that was never registered', async () => {
    const { deps } = await setup('none')
    await expect(signInWithPasskey(deps, { endpoint: SIGN_IN, prf: false })).rejects.toThrow(
      'unknown passkey',
    )
  })

  it('refuses an assertion signed for another origin', async () => {
    const { deps } = await setup('none')
    await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: false })
    const phisher = await createSoftAuthenticator({ origin: 'https://evil.example', rpId: RP_ID })
    await expect(
      signInWithPasskey(
        { ...deps, startAuthentication: phisher.startAuthentication },
        { endpoint: SIGN_IN, prf: false },
      ),
    ).rejects.toThrow()
  })
})

describe('PRF hand-off', () => {
  it('present: returns 32 bytes, the same on every sign-in, and posts none of them', async () => {
    const { deps, authenticator, posted } = await setup('full')
    const registered = await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: true })
    const first = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: true })
    const second = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: true })

    expect(registered.prf.status).toBe('provided')
    expect(first.prf.status).toBe('provided')
    expect(first.prf.output).toHaveLength(32)
    expect([...second.prf.output!]).toEqual([...first.prf.output!])
    expect([...registered.prf.output!]).toEqual([...first.prf.output!])

    expectNoPrfPosted(posted, authenticator)
    expect((await listPasskeys(db, 'u1'))[0]?.prfCapable).toBe(true)
  })

  it('hands the authenticator the PRF input as bytes', async () => {
    const { deps, authenticator } = await setup('full')
    await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: true })
    await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: true })
    for (const options of authenticator.seen) {
      expect(options.extensions?.prf?.eval?.first).toBe(PASSKEY_PRF_INPUT)
    }
  })

  it('absent: an authenticator without PRF still signs in, and says so', async () => {
    const { deps, authenticator, posted } = await setup('none')
    const registered = await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: true })
    const signedIn = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: true })

    expect(registered.prf).toEqual({ status: 'unavailable', output: null })
    expect(signedIn.userId).toBe('u1')
    expect(signedIn.prf).toEqual({ status: 'unavailable', output: null })
    expectNoPrfPosted(posted, authenticator)
    expect((await listPasskeys(db, 'u1'))[0]?.prfCapable).toBe(false)
  })

  it('not requested: asks for nothing and reports that, even from a capable authenticator', async () => {
    const { deps, authenticator } = await setup('full')
    await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: false })
    const signedIn = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: false })
    expect(signedIn.prf).toEqual({ status: 'not-requested', output: null })
    expect(authenticator.seen.every((options) => !options.extensions?.prf)).toBe(true)
  })

  it('enabled at registration but evaluated only on use: asks the new passkey once more, locally', async () => {
    const { deps, authenticator, posted } = await setup('on-assertion')
    const registered = await registerPasskey(deps, { endpoint: REGISTER, user: USER, prf: true })

    expect(registered.prf.status).toBe('provided')
    // Two posts (options, attestation): the extra assertion never reached the server.
    expect(posted).toHaveLength(2)
    expect(authenticator.seen).toHaveLength(2)
    expect(authenticator.seen[1]?.allowCredentials).toEqual([
      { id: authenticator.credentialId, type: 'public-key', transports: ['internal'] },
    ])

    const signedIn = await signInWithPasskey(deps, { endpoint: SIGN_IN, prf: true })
    expect([...signedIn.prf.output!]).toEqual([...registered.prf.output!])
    expect((await listPasskeys(db, 'u1'))[0]?.prfCapable).toBe(true)
  })
})

describe('storage', () => {
  it('spends a challenge on first read, and never returns an expired one', async () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    await storePasskeyChallenge(db, 'a1', 'challenge-1', now)
    expect(await takePasskeyChallenge(db, 'a1', now + 1000)).toBe('challenge-1')
    expect(await takePasskeyChallenge(db, 'a1', now + 1000)).toBeNull()

    await storePasskeyChallenge(db, 'a2', 'challenge-2', now)
    const late = now + PASSKEY_CHALLENGE_TTL_SECONDS * 1000 + 1
    expect(await takePasskeyChallenge(db, 'a2', late)).toBeNull()
  })

  const credential = (id: string) => ({ id, publicKey: 'pk', counter: 0, backedUp: true })

  it('lists and removes only the owner’s passkeys', async () => {
    await addUser('u2', 'grace@example.com')
    await savePasskey(db, 'u1', credential('c1'), { name: 'Phone', prfCapable: true })
    await savePasskey(db, 'u2', credential('c2'), { name: 'Key', prfCapable: false })

    expect((await listPasskeys(db, 'u1')).map(passkeySummary)).toEqual([
      expect.objectContaining({ id: 'c1', name: 'Phone', backedUp: true, prfCapable: true }),
    ])
    expect(passkeySummary((await findPasskey(db, 'c1'))!)).not.toHaveProperty('publicKey')

    expect(await removePasskey(db, 'u1', 'c2')).toBe(false)
    expect(await findPasskey(db, 'c2')).not.toBeNull()
    expect(await removePasskey(db, 'u2', 'c2')).toBe(true)
    expect(await findPasskey(db, 'c2')).toBeNull()
  })

  it('stops at the per-account ceiling', async () => {
    for (let i = 0; i < MAX_PASSKEYS_PER_USER; i++) {
      await savePasskey(db, 'u1', credential(`c${i}`), { name: `k${i}`, prfCapable: false })
    }
    expect(await savePasskey(db, 'u1', credential('extra'), { name: 'x', prfCapable: false })).toBe(
      'limit_reached',
    )
  })
})

// nuxt-auth-utils hands a callback's error to onError only when `isNuxtError`
// accepts it, and turns anything else into a 500. That check needs `status`,
// which h3 v1's createError never sets: a refusal built with it would reach the
// browser as "could not be verified" instead of its own code.
describe('passkey ceremony errors', () => {
  const event = {} as RequestEvent
  const thrownBy = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return error as NuxtError
    }
    throw new Error('expected a throw')
  }

  it('builds refusals the handlers recognise, which h3 v1 errors are not', () => {
    expect(isNuxtError(createError({ status: 409, message: 'x' }))).toBe(true)
    expect(isNuxtError(h3CreateError({ statusCode: 409, message: 'x' }))).toBe(false)
  })

  it('passes a 4xx refusal through with its code', () => {
    const refusal = createError({ status: 409, message: 'x', data: { code: 'passkey_limit' } })
    expect(thrownBy(() => passkeyCeremonyFailed(event, refusal))).toBe(refusal)
  })

  it('answers a response that did not verify as a 400, not a 500', () => {
    const failed = createError({ status: 500, message: 'Failed to authenticate credential' })
    const error = thrownBy(() => passkeyCeremonyFailed(event, failed))
    expect(error.status).toBe(400)
    expect(error.data).toEqual({ code: 'passkey_rejected' })
  })
})
