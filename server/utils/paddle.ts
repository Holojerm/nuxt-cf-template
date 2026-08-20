// Paddle webhook signature verification — Web Crypto only (no node:crypto), so
// it runs identically on Cloudflare Workers and in local dev.
//
// Paddle signs webhooks with HMAC-SHA256 over `${ts}:${rawBody}` and sends
// `Paddle-Signature: ts=<unix seconds>;h1=<hex>` (h1 may repeat during secret
// rotation). Verify against the EXACT raw body bytes — any reformatting
// invalidates the signature. Docs: developer.paddle.com/webhooks/signature-verification

const encoder = new TextEncoder()

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!
  return diff === 0
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
