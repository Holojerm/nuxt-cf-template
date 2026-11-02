// Paddle webhook signature verification — pure Web Crypto, so it runs in
// workerd exactly as it does in production.

import { describe, expect, it } from 'vitest'
import { verifyPaddleSignature } from '../server/utils/paddle'

const SECRET = 'pdl_ntfset_test_secret'
const BODY = '{"event_type":"subscription.created","data":{"id":"sub_1"}}'

async function sign(ts: string, body: string, secret = SECRET): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${body}`))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function nowTs(): string {
  return Math.floor(Date.now() / 1000).toString()
}

describe('verifyPaddleSignature', () => {
  it('accepts a correctly signed fresh payload', async () => {
    const ts = nowTs()
    const h1 = await sign(ts, BODY)
    const result = await verifyPaddleSignature(BODY, `ts=${ts};h1=${h1}`, SECRET)
    expect(result).toEqual({ valid: true })
  })

  it('rejects a tampered body', async () => {
    const ts = nowTs()
    const h1 = await sign(ts, BODY)
    const result = await verifyPaddleSignature(`${BODY} `, `ts=${ts};h1=${h1}`, SECRET)
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects the wrong secret', async () => {
    const ts = nowTs()
    const h1 = await sign(ts, BODY, 'some-other-secret')
    const result = await verifyPaddleSignature(BODY, `ts=${ts};h1=${h1}`, SECRET)
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects a stale timestamp (replay)', async () => {
    const ts = (Math.floor(Date.now() / 1000) - 60).toString()
    const h1 = await sign(ts, BODY)
    const result = await verifyPaddleSignature(BODY, `ts=${ts};h1=${h1}`, SECRET)
    expect(result.reason).toBe('stale_timestamp')
  })

  it('accepts a rotated secret via a second h1', async () => {
    const ts = nowTs()
    const h1 = await sign(ts, BODY)
    const result = await verifyPaddleSignature(BODY, `ts=${ts};h1=dead;h1=${h1}`, SECRET)
    expect(result).toEqual({ valid: true })
  })

  it('rejects missing or malformed headers', async () => {
    expect((await verifyPaddleSignature(BODY, undefined, SECRET)).reason).toBe('malformed_header')
    expect((await verifyPaddleSignature(BODY, 'garbage', SECRET)).reason).toBe('malformed_header')
    expect((await verifyPaddleSignature(BODY, 'ts=abc;h1=00', SECRET)).reason).toBe(
      'malformed_header',
    )
  })
})
