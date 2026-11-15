// What the browser derives from a password. WebCrypto only, so the same code
// runs in the page and in the workerd test pool.
//
//   master  = PBKDF2-SHA256(NFKC(password), salt, iterations) → 32 bytes
//   proof   = HKDF-SHA256(master, info "credentials/v1/sign-in-proof") → sent
//   unlock  = HKDF-SHA256(master, info "credentials/v1/unlock-key")    → stays
//
// The two HKDF outputs are independent: the server, which sees the proof,
// cannot compute the unlock key from it. That is the whole reason for the
// split, and why the raw password and the master key never leave this module.

const encoder = new TextEncoder()

/** Bumped only by a change to the construction above; stored with each user. */
export const CREDENTIALS_KDF_VERSION = 1

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Raise it in runtime config, never lower it. */
export const CREDENTIALS_DEFAULT_ITERATIONS = 600_000
export const CREDENTIALS_MIN_ITERATIONS = 100_000
export const CREDENTIALS_MAX_ITERATIONS = 10_000_000

export const CREDENTIALS_SALT_BYTES = 16
export const CREDENTIALS_KEY_BYTES = 32

const PROOF_INFO = 'credentials/v1/sign-in-proof'
const UNLOCK_INFO = 'credentials/v1/unlock-key'

export interface KdfParams {
  /** base64url, CREDENTIALS_SALT_BYTES long. */
  salt: string
  iterations: number
}

export interface DerivedCredentials {
  /** base64url of 32 bytes. The only derived value the server ever receives. */
  proof: string
  /** 32 raw bytes. Never serialised by this layer; handed to the app's unlock hook. */
  unlockKey: Uint8Array
}

export function credentialsBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function credentialsFromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function generateKdfSalt(): string {
  return credentialsBase64url(crypto.getRandomValues(new Uint8Array(CREDENTIALS_SALT_BYTES)))
}

async function expand(master: CryptoKey, info: string): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    master,
    CREDENTIALS_KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * NFKC first: the same password typed on two keyboards (a composed "é" and an
 * "e" plus a combining accent) must derive the same key, or the account opens
 * on one device and not the other.
 */
export async function deriveCredentials(
  password: string,
  params: KdfParams,
): Promise<DerivedCredentials> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const masterBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: credentialsFromBase64url(params.salt),
      iterations: params.iterations,
    },
    material,
    CREDENTIALS_KEY_BYTES * 8,
  )
  const master = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits'])
  const [proof, unlockKey] = await Promise.all([
    expand(master, PROOF_INFO),
    expand(master, UNLOCK_INFO),
  ])
  return { proof: credentialsBase64url(proof), unlockKey }
}
