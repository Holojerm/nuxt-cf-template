// Paddle webhook signature verification — Web Crypto only (no node:crypto), so
// it runs identically on Cloudflare Workers and in local dev.
//
// Paddle signs webhooks with HMAC-SHA256 over `${ts}:${rawBody}` and sends
// `Paddle-Signature: ts=<unix seconds>;h1=<hex>` (h1 may repeat during secret
// rotation). Verify against the EXACT raw body bytes — any reformatting
// invalidates the signature. Docs: developer.paddle.com/webhooks/signature-verification
//
// The hex encoder and the constant-time compare come from server/utils/hash.ts
// — one copy each, shared with the unsubscribe token check, because a second
// timing-safe compare is a second place for somebody to "simplify" the loop.

import { timingSafeEqual, toHex } from './hash'

const encoder = new TextEncoder()

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

export interface PaddleSignatureCheck {
  valid: boolean
  reason?: 'malformed_header' | 'stale_timestamp' | 'signature_mismatch'
}

/**
 * Verify a Paddle webhook. `toleranceSeconds` bounds replay attacks — Paddle's
 * documented default is 5 seconds; raise it slightly if you see legitimate
 * deliveries rejected for clock skew.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = 5,
): Promise<PaddleSignatureCheck> {
  if (!signatureHeader) return { valid: false, reason: 'malformed_header' }

  let ts = ''
  const h1s: string[] = []
  for (const part of signatureHeader.split(';')) {
    const [k, v] = part.split('=', 2)
    if (k === 'ts' && v) ts = v
    if (k === 'h1' && v) h1s.push(v)
  }
  if (!/^\d+$/.test(ts) || h1s.length === 0) return { valid: false, reason: 'malformed_header' }

  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (age > toleranceSeconds) return { valid: false, reason: 'stale_timestamp' }

  const expected = await hmacSha256Hex(secret, `${ts}:${rawBody}`)
  const valid = h1s.some((h1) => timingSafeEqual(expected, h1))
  return valid ? { valid: true } : { valid: false, reason: 'signature_mismatch' }
}
