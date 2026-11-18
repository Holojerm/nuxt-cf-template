// The encryption against RFC 8291's own example (Section 5, Appendix A), then
// from the receiving side as a browser would do it, and the VAPID token
// against the key it claims to be signed by.

import { describe, expect, it } from 'vitest'

import {
  encryptPushPayload,
  MAX_PUSH_PLAINTEXT_BYTES,
  vapidAuthorization,
} from '../server/utils/push-crypto'
import { base64UrlToBytes, bytesToBase64Url } from '../shared/utils/push'
import { decryptPushPayload, generateBrowserKeys } from './lib/push-receiver'

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

const text = (value: string) => new TextEncoder().encode(value)

describe('encryptPushPayload', () => {
  it("produces RFC 8291's example message, byte for byte", async () => {
    const body = await encryptPushPayload({
      plaintext: text(RFC.plaintext),
      uaPublic: base64UrlToBytes(RFC.uaPublic),
      authSecret: base64UrlToBytes(RFC.authSecret),
      fixed: {
        salt: base64UrlToBytes(RFC.salt),
        privateKey: RFC.asPrivate,
        publicKey: RFC.asPublic,
      },
    })
    expect(bytesToBase64Url(body.subarray(0, 86))).toBe(RFC.header)
    expect(bytesToBase64Url(body.subarray(86))).toBe(RFC.ciphertext)
  })

  it('makes a message the browser it was encrypted for can read', async () => {
    const browser = await generateBrowserKeys()
    const body = await encryptPushPayload({
      plaintext: text('{"title":"Post"}'),
      uaPublic: base64UrlToBytes(browser.p256dh),
      authSecret: base64UrlToBytes(browser.auth),
    })
    expect(await decryptPushPayload(browser, body)).toBe('{"title":"Post"}')
  })

  it('uses a new key and salt for every message', async () => {
    const browser = await generateBrowserKeys()
    const input = {
      plaintext: text('same'),
      uaPublic: base64UrlToBytes(browser.p256dh),
      authSecret: base64UrlToBytes(browser.auth),
    }
    const [first, second] = await Promise.all([
      encryptPushPayload(input),
      encryptPushPayload(input),
    ])
    expect(bytesToBase64Url(first.subarray(0, 16))).not.toBe(
      bytesToBase64Url(second.subarray(0, 16)),
    )
    expect(bytesToBase64Url(first.subarray(21, 86))).not.toBe(
      bytesToBase64Url(second.subarray(21, 86)),
    )
  })

  it('refuses a message a push service would refuse', async () => {
    const browser = await generateBrowserKeys()
    const keys = {
      uaPublic: base64UrlToBytes(browser.p256dh),
      authSecret: base64UrlToBytes(browser.auth),
    }
    const largest = await encryptPushPayload({
      plaintext: new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES),
      ...keys,
    })
    expect(largest.length).toBe(4096)
    await expect(
      encryptPushPayload({ plaintext: new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES + 1), ...keys }),
    ).rejects.toThrow(RangeError)
  })
})

describe('vapidAuthorization', () => {
  const NOW = Date.UTC(2026, 10, 18)
  const json = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)))

  it('signs a token for the push service, verifiable with the public key it names', async () => {
    const header = await vapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      subject: 'https://app.example',
      publicKey: RFC.asPublic,
      privateKey: RFC.asPrivate,
      now: NOW,
    })
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!
    const [, head, claims, signature, k] = match as unknown as string[]
    expect(k).toBe(RFC.asPublic)
    expect(json(head!)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(json(claims!)).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: NOW / 1000 + 12 * 60 * 60,
      sub: 'https://app.example',
    })

    const key = await crypto.subtle.importKey(
      'raw',
      base64UrlToBytes(k!),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlToBytes(signature!),
      text(`${head}.${claims}`),
    )
    expect(verified).toBe(true)
  })

  it('rejects a public key that is not a P-256 point', async () => {
    await expect(
      vapidAuthorization({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        subject: 'https://app.example',
        publicKey: 'AAAA',
        privateKey: RFC.asPrivate,
      }),
    ).rejects.toThrow('not an uncompressed P-256 point')
  })
})
