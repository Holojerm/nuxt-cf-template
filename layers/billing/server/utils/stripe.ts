// Stripe webhook signature verification. Web Crypto only (no node:crypto, no
// Stripe package), so it runs identically on Cloudflare Workers and in local dev.
//
// Stripe signs webhooks with HMAC-SHA256 over `${t}.${rawBody}` and sends
// `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>][,v0=…]`. `v1` repeats
// while an endpoint secret is being rolled (both secrets sign for a while);
// `v0` is a test-only scheme and is ignored. Verify against the EXACT raw body
// bytes: any reformatting invalidates the signature.
// Docs: docs.stripe.com/webhooks#verify-manually
//
// The hex encoder and the constant-time compare come from server/utils/hash.ts,
// one copy each, shared with the unsubscribe token check.

import { timingSafeEqual, toHex } from '#server/utils/hash'

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

export interface StripeSignatureCheck {
  valid: boolean
  reason?: 'malformed_header' | 'stale_timestamp' | 'signature_mismatch'
}

/** Stripe's own libraries accept a delivery up to five minutes old. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Verify a Stripe webhook. `toleranceSeconds` bounds replay of a captured
 * delivery; the event-id ledger (`applyBillingEvent`) is what makes a replay
 * inside the window harmless.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): Promise<StripeSignatureCheck> {
  if (!signatureHeader) return { valid: false, reason: 'malformed_header' }

  let t = ''
  const v1s: string[] = []
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=', 2)
    if (k === 't' && v) t = v
    if (k === 'v1' && v) v1s.push(v)
  }
  if (!/^\d+$/.test(t) || v1s.length === 0) return { valid: false, reason: 'malformed_header' }

  const age = Math.abs(Date.now() / 1000 - Number(t))
  if (age > toleranceSeconds) return { valid: false, reason: 'stale_timestamp' }

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`)
  const valid = v1s.some((v1) => timingSafeEqual(expected, v1))
  return valid ? { valid: true } : { valid: false, reason: 'signature_mismatch' }
}
