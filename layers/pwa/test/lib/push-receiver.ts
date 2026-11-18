// The receiving half of RFC 8291, as a browser does it: tests decrypt what the
// layer encrypted, so a message that only its sender can read fails here.

import { base64UrlToBytes, bytesToBase64Url } from '../../shared/utils/push'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const encoder = new TextEncoder()

export interface BrowserKeys {
  /** What a PushSubscription reports: the public key and the auth secret, base64url. */
  p256dh: string
  auth: string
  privateKey: CryptoKey
}

export async function generateBrowserKeys(): Promise<BrowserKeys> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  return {
    p256dh: bytesToBase64Url(raw),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    privateKey: pair.privateKey,
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits),
  )
}

/** The plaintext of an `aes128gcm` push body, or a throw if it was not meant for these keys. */
export async function decryptPushPayload(browser: BrowserKeys, body: Uint8Array): Promise<string> {
  const salt = body.subarray(0, 16)
  const keyLength = body[20]!
  const senderPublic = body.subarray(21, 21 + keyLength)
  const ciphertext = body.subarray(21 + keyLength)

  const senderKey = await crypto.subtle.importKey('raw', senderPublic, ECDH, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, browser.privateKey, 256),
  )
  const info = new Uint8Array([
    ...encoder.encode('WebPush: info\0'),
    ...base64UrlToBytes(browser.p256dh),
    ...senderPublic,
  ])
  const ikm = await hkdf(base64UrlToBytes(browser.auth), shared, info, 256)
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 128)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 96)
  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['decrypt'])
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext),
  )
  // Strip the 0x02 delimiter that closes the last record.
  return new TextDecoder().decode(record.subarray(0, record.lastIndexOf(2)))
}
