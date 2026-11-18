// Web Push's two pieces of cryptography, on WebCrypto alone: the message is
// encrypted to the browser's key (RFC 8291, in the `aes128gcm` coding of RFC
// 8188), and the request is signed with the app's VAPID key (RFC 8292).
// test/push-crypto.test.ts holds the first to the RFC's own test vector.

import { base64UrlToBytes, bytesToBase64Url } from '../../shared/utils/push'

const encoder = new TextEncoder()
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const RECORD_SIZE = 4096
/** salt (16), record size (4), key id length (1), the sender's public key (65). */
const HEADER_LENGTH = 86
/**
 * Push services take 4096 bytes at most. The header, the GCM tag (16) and the
 * padding delimiter (1) come out of that.
 */
export const MAX_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_LENGTH - 17

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * A P-256 private key as WebCrypto imports it. VAPID keys travel as the raw
 * scalar and the uncompressed public point, both base64url; a JWK wants the
 * point split into x and y.
 */
function privateJwk(privateKey: string, publicKey: string): JsonWebKey {
  const point = base64UrlToBytes(publicKey)
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error('Public key is not an uncompressed P-256 point')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    d: privateKey,
    x: bytesToBase64Url(point.subarray(1, 33)),
    y: bytesToBase64Url(point.subarray(33)),
  }
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bits: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits),
  )
}

export interface PushEncryptionInput {
  plaintext: Uint8Array
  /** The subscription's `p256dh`: the browser's public key, 65 bytes. */
  uaPublic: Uint8Array<ArrayBuffer>
  /** The subscription's `auth` secret, 16 bytes. */
  authSecret: Uint8Array<ArrayBuffer>
  /**
   * The sender's key pair and salt, for reproducing a test vector. A real
   * message leaves this out: both are made fresh for every message, and
   * reusing either breaks the encryption.
   */
  fixed?: { salt: Uint8Array<ArrayBuffer>; privateKey: string; publicKey: string }
}

/** The request body for one push message: the RFC 8188 header, then one encrypted record. */
export async function encryptPushPayload(
  input: PushEncryptionInput,
): Promise<Uint8Array<ArrayBuffer>> {
  if (input.plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new RangeError(`A push message holds ${MAX_PUSH_PLAINTEXT_BYTES} bytes at most`)
  }

  let salt: Uint8Array<ArrayBuffer>
  let senderPrivate: CryptoKey
  let senderPublic: Uint8Array<ArrayBuffer>
  if (input.fixed) {
    salt = input.fixed.salt
    senderPublic = base64UrlToBytes(input.fixed.publicKey)
    senderPrivate = await crypto.subtle.importKey(
      'jwk',
      privateJwk(input.fixed.privateKey, input.fixed.publicKey),
      ECDH,
      false,
      ['deriveBits'],
    )
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16))
    const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
    senderPrivate = pair.privateKey
    senderPublic = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    )
  }

  const uaKey = await crypto.subtle.importKey('raw', input.uaPublic, ECDH, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, senderPrivate, 256),
  )

  // RFC 8291 §3.4: the auth secret and both public keys go into the key, so a
  // message is bound to this subscription and this sender.
  const ikm = await hkdf(
    input.authSecret,
    shared,
    concat(encoder.encode('WebPush: info\0'), input.uaPublic, senderPublic),
    256,
  )
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 128)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 96)

  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  // One record. 0x02 marks it as the last, and nothing pads it.
  const record = concat(input.plaintext, Uint8Array.of(2))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, record),
  )

  const header = new Uint8Array(HEADER_LENGTH)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = senderPublic.length
  header.set(senderPublic, 21)
  return concat(header, ciphertext)
}

export interface VapidInput {
  /** The subscription's endpoint; the token is good for its origin only. */
  endpoint: string
  /** A `mailto:` or `https:` URL the push service can reach the sender at. */
  subject: string
  publicKey: string
  privateKey: string
  now?: number
}

/** Twelve hours. RFC 8292 allows a day; a shorter token is worth less if a log leaks it. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

/** The `Authorization` header value for a push request (RFC 8292, the `vapid` scheme). */
export async function vapidAuthorization(input: VapidInput): Promise<string> {
  const encode = (value: object) => bytesToBase64Url(encoder.encode(JSON.stringify(value)))
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(input.endpoint).origin,
    exp: Math.floor((input.now ?? Date.now()) / 1000) + VAPID_LIFETIME_SECONDS,
    sub: input.subject,
  })}`
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk(input.privateKey, input.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  // WebCrypto's ECDSA signature is r and s back to back, which is what a JWS wants.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned),
  )
  return `vapid t=${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}, k=${input.publicKey}`
}

/**
 * A new VAPID key pair in the form the layer's config takes: the private
 * scalar and the uncompressed public point, base64url. For
 * scripts/vapid-keys.ts and the tests; an app makes its pair once and keeps it,
 * because every existing subscription is bound to the public key.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const point = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer
  return { publicKey: bytesToBase64Url(new Uint8Array(point)), privateKey: jwk.d! }
}
