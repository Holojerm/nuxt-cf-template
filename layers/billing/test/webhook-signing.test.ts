// Proves e2e/sign.ts’s `signPaddleWebhook` isn’t quietly wrong.
//
// layers/billing/server/utils/paddle.ts's own HMAC helper (`hmacSha256Hex`) is a local,
// unexported function, so the fixture can't import it and instead mirrors the
// construction by hand — same shape as layers/billing/test/paddle.test.ts's `sign` helper on
// the vitest side. A hand-written mirror is exactly the kind of thing that can
// drift from what it mirrors without either copy's own tests noticing, so this
// file checks the fixture against the REAL verifier rather than trusting it by
// inspection. Every other E2E spec's `sendPaddleEvent` calls depend on this
// being right — if it silently broke, every webhook in the suite would 401 and
// the flows below it would never really run.

import { describe, expect, it } from 'vitest'

import { verifyPaddleSignature } from '../server/utils/paddle'
import { signPaddleWebhook } from './e2e/sign'
import { PADDLE_TEST_WEBHOOK_SECRET as SECRET } from './e2e/webhook-secret'

describe('the E2E fixture’s signPaddleWebhook', () => {
  it('a webhook signed by the fixture verifies against the real Paddle check', async () => {
    const body = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'subscription.activated',
      data: { id: 'sub_1', status: 'active' },
    })

    const header = await signPaddleWebhook(body, SECRET)
    const result = await verifyPaddleSignature(body, header, SECRET)

    expect(result).toEqual({ valid: true })
  })

  it('a body tampered with after signing fails the real Paddle check', async () => {
    const body = '{"event_type":"subscription.activated","data":{"id":"sub_1"}}'
    const header = await signPaddleWebhook(body, SECRET)

    const result = await verifyPaddleSignature(`${body} `, header, SECRET)

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature_mismatch')
  })

  it('signing with the wrong secret fails the real Paddle check', async () => {
    const body = '{"event_type":"subscription.activated","data":{"id":"sub_1"}}'
    const header = await signPaddleWebhook(body, 'not-the-configured-secret')

    const result = await verifyPaddleSignature(body, header, SECRET)

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature_mismatch')
  })
})
