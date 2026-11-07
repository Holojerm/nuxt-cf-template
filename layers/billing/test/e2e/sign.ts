// Signs Paddle webhooks for the billing E2E suite. A separate module with no
// Playwright import so the vitest check in ../webhook-signing.test.ts can load it.

import { toHex } from '../../../../server/utils/hash'
import { PADDLE_TEST_WEBHOOK_SECRET } from './webhook-secret'

// Mirrors layers/billing/server/utils/paddle.ts's verifier exactly.
// `hmacSha256Hex` in that file is a local, unexported helper, so it can't be
// imported directly; `toHex` is exported and IS imported, which is what keeps
// the hex-encoding step from becoming a second copy that could quietly stop
// matching. The HMAC construction itself (`${ts}:${rawBody}`, `ts=…;h1=…`) is
// mirrored here the same way layers/billing/test/paddle.test.ts's own `sign` helper mirrors
// it for the vitest suite — see ../webhook-signing.test.ts (vitest), which checks this
// copy against the real `verifyPaddleSignature` rather than trusting it by
// inspection.

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
 * The `Paddle-Signature` header value, built the way layers/billing/server/utils/paddle.ts
 * verifies it.
 *
 * ── Timing contract ─────────────────────────────────────────────────────────
 * `ts` is stamped from `Date.now()` the instant this is called, and the
 * server checks it against a 5-SECOND window (`toleranceSeconds` in
 * layers/billing/server/utils/paddle.ts — production's value; not touched here). Call this
 * as the LAST step before `apiRequest.post(...)`, with the request body
 * already fully built — never earlier, never cached and reused. `sendPaddleEvent`
 * below is the only real caller and does exactly that; see globalSetup.ts for
 * the other half of keeping this window from being eaten by a cold compile.
 */
export async function signPaddleWebhook(
  rawBody: string,
  secret: string = PADDLE_TEST_WEBHOOK_SECRET,
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const h1 = await hmacSha256Hex(secret, `${ts}:${rawBody}`)
  return `ts=${ts};h1=${h1}`
}
