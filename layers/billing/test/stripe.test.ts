// Stripe webhook signature verification: pure Web Crypto, so it runs in
// workerd exactly as it does in production.

import { describe, expect, it } from 'vitest'
import { verifyStripeSignature } from '../server/utils/stripe'

const SECRET = 'whsec_test_secret'
const BODY = '{"id":"evt_1","type":"customer.subscription.created","data":{"object":{}}}'

async function sign(ts: string, body: string, secret = SECRET): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const nowTs = (): string => Math.floor(Date.now() / 1000).toString()

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed fresh payload', async () => {
    const ts = nowTs()
    const v1 = await sign(ts, BODY)
    expect(await verifyStripeSignature(BODY, `t=${ts},v1=${v1}`, SECRET)).toEqual({ valid: true })
  })

  it('accepts when either of two v1 values matches (secret rotation)', async () => {
    const ts = nowTs()
    const good = await sign(ts, BODY)
    const old = await sign(ts, BODY, 'whsec_old')
    expect(await verifyStripeSignature(BODY, `t=${ts},v1=${old},v1=${good}`, SECRET)).toEqual({
      valid: true,
    })
    expect(await verifyStripeSignature(BODY, `t=${ts},v1=${good},v1=${old}`, SECRET)).toEqual({
      valid: true,
    })
  })

  it('ignores v0, so a v0-only header is not a valid signature', async () => {
    const ts = nowTs()
    const v0 = await sign(ts, BODY)
    const result = await verifyStripeSignature(BODY, `t=${ts},v0=${v0}`, SECRET)
    expect(result).toEqual({ valid: false, reason: 'malformed_header' })
    const alongside = await verifyStripeSignature(BODY, `t=${ts},v0=${v0},v1=dead`, SECRET)
    expect(alongside.reason).toBe('signature_mismatch')
  })

  it('rejects missing or malformed headers', async () => {
    expect((await verifyStripeSignature(BODY, undefined, SECRET)).reason).toBe('malformed_header')
    expect((await verifyStripeSignature(BODY, 'garbage', SECRET)).reason).toBe('malformed_header')
    expect((await verifyStripeSignature(BODY, 't=abc,v1=00', SECRET)).reason).toBe(
      'malformed_header',
    )
    expect((await verifyStripeSignature(BODY, `t=${nowTs()}`, SECRET)).reason).toBe(
      'malformed_header',
    )
  })

  it('rejects a timestamp beyond 300 seconds, either side, and accepts one inside', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const offset of [-301 - 5, 301 + 5]) {
      const ts = String(now + offset)
      const v1 = await sign(ts, BODY)
      const result = await verifyStripeSignature(BODY, `t=${ts},v1=${v1}`, SECRET)
      expect(result.reason).toBe('stale_timestamp')
    }
    const ts = String(now - 290)
    const v1 = await sign(ts, BODY)
    expect(await verifyStripeSignature(BODY, `t=${ts},v1=${v1}`, SECRET)).toEqual({ valid: true })
  })

  it('honours a custom tolerance', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60)
    const v1 = await sign(ts, BODY)
    const result = await verifyStripeSignature(BODY, `t=${ts},v1=${v1}`, SECRET, 30)
    expect(result.reason).toBe('stale_timestamp')
  })

  it('rejects a tampered body', async () => {
    const ts = nowTs()
    const v1 = await sign(ts, BODY)
    const result = await verifyStripeSignature(`${BODY} `, `t=${ts},v1=${v1}`, SECRET)
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects the wrong secret', async () => {
    const ts = nowTs()
    const v1 = await sign(ts, BODY, 'whsec_other')
    const result = await verifyStripeSignature(BODY, `t=${ts},v1=${v1}`, SECRET)
    expect(result.reason).toBe('signature_mismatch')
  })
})
