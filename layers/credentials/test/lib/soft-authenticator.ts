// A software authenticator: what a platform passkey returns to the browser,
// built with WebCrypto so @simplewebauthn/server can verify it for real.
// It stands in for `startRegistration` / `startAuthentication`, and can be told
// how much of the PRF extension it supports.

const encoder = new TextEncoder()

const b64u = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64u = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  )
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

// ── Just enough CBOR for an attestation object and a COSE key ────────────────
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>

function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value)
  if (value < 256) return Uint8Array.of((major << 5) | 24, value)
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff)
}

function cbor(value: Cbor): Uint8Array {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = encoder.encode(value)
    return concat(head(3, bytes.length), bytes)
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value)
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]))
}

/** WebCrypto signs as r‖s; WebAuthn carries ECDSA signatures as ASN.1 DER. */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    const body = trimmed[0]! & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
    return concat(Uint8Array.of(0x02, body.length), body)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

export type PrfSupport =
  /** No PRF at all: the extension is ignored. */
  | 'none'
  /** Reports `enabled` at registration, evaluates only on an assertion. */
  | 'on-assertion'
  /** Evaluates at registration too. */
  | 'full'

export interface SoftAuthenticatorOptions {
  origin: string
  rpId: string
  prf?: PrfSupport
}

interface CeremonyOptions {
  challenge: string
  allowCredentials?: { id: string }[]
  extensions?: { prf?: { eval?: { first?: unknown } } }
}

export async function createSoftAuthenticator({
  origin,
  rpId,
  prf = 'none',
}: SoftAuthenticatorOptions) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const prfKey = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const rpIdHash = await sha256(encoder.encode(rpId))
  let counter = 0

  /** What every ceremony was asked, so a test can assert on the PRF input. */
  const seen: CeremonyOptions[] = []

  const clientData = (type: string, challenge: string) =>
    encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

  async function evaluate(options: CeremonyOptions): Promise<ArrayBuffer | undefined> {
    const first = options.extensions?.prf?.eval?.first
    // A real authenticator is handed bytes. A base64url string here is the bug
    // the ceremony module exists to avoid, so it is not quietly accepted.
    if (!(first instanceof Uint8Array)) return undefined
    return crypto.subtle.sign('HMAC', prfKey, new Uint8Array(first))
  }

  async function startRegistration(input: { optionsJSON: never }) {
    const options = input.optionsJSON as CeremonyOptions
    seen.push(options)
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    const coseKey = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64u(jwk.x!)],
        [-3, fromB64u(jwk.y!)],
      ]),
    )
    // Flags: user present, user verified, attested credential data follows.
    const authData = concat(
      rpIdHash,
      Uint8Array.of(0x45),
      Uint8Array.of(0, 0, 0, counter),
      new Uint8Array(16),
      Uint8Array.of(0, credentialId.length),
      credentialId,
      coseKey,
    )
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    const requested = Boolean(options.extensions?.prf)
    const first = prf === 'full' ? await evaluate(options) : undefined
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults:
        requested && prf !== 'none'
          ? { prf: { enabled: true, ...(first ? { results: { first } } : {}) } }
          : {},
    }
  }

  async function startAuthentication(input: { optionsJSON: never }) {
    const options = input.optionsJSON as CeremonyOptions
    seen.push(options)
    const allowed = options.allowCredentials
    if (allowed && !allowed.some((entry) => entry.id === b64u(credentialId))) {
      throw Object.assign(new Error('no matching credential'), { name: 'NotAllowedError' })
    }
    counter += 1
    const clientDataJSON = clientData('webauthn.get', options.challenge)
    const authData = concat(rpIdHash, Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, counter))
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        concat(authData, await sha256(clientDataJSON)),
      ),
    )
    const first = prf === 'none' ? undefined : await evaluate(options)
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(toDer(signature)),
      },
      clientExtensionResults: first ? { prf: { results: { first } } } : {},
    }
  }

  return { credentialId: b64u(credentialId), seen, startRegistration, startAuthentication }
}

export type SoftAuthenticator = Awaited<ReturnType<typeof createSoftAuthenticator>>
