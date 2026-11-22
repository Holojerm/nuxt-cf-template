// Signs Stripe webhooks for the billing E2E suite. A separate module with no
// Playwright import so the vitest check in ../webhook-signing.test.ts can load it.

import { toHex } from '../../../../server/utils/hash'
import { STRIPE_TEST_WEBHOOK_SECRET } from './webhook-secret'

// Mirrors layers/billing/server/utils/stripe.ts's verifier. Its HMAC helper is
// a local, unexported function, so the construction is repeated here
// (`${t}.${rawBody}`, `t=…,v1=…`); `toHex` is imported so the hex-encoding step
// cannot become a second copy that quietly stops matching. ../webhook-signing.test.ts
// checks this copy against the real `verifyStripeSignature` rather than
// trusting it by inspection.

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

/**
 * The `Stripe-Signature` header value for `rawBody`, stamped with the current
 * time. The server accepts five minutes of clock difference, so unlike a
 * tighter scheme there is no race to win, but sign as the last step before
 * posting all the same.
 */
export async function signStripeWebhook(
  rawBody: string,
  secret: string = STRIPE_TEST_WEBHOOK_SECRET,
): Promise<string> {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`
}
