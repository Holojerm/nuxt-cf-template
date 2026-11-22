// Proves e2e/sign.ts's `signStripeWebhook` isn't quietly wrong.
//
// The verifier's HMAC helper (`hmacSha256Hex` in server/utils/stripe.ts) is
// local and unexported, so the fixture mirrors the construction by hand. A
// hand-written mirror can drift from what it mirrors without either copy's own
// tests noticing, so this file checks the fixture against the REAL verifier.
// Every E2E spec's webhook send depends on this being right: if it silently
// broke, every webhook in the suite would 401 and the flows below it would
// never really run.

import { describe, expect, it } from 'vitest'

import { verifyStripeSignature } from '../server/utils/stripe'
import { signStripeWebhook } from './e2e/sign'
import { STRIPE_TEST_WEBHOOK_SECRET as SECRET } from './e2e/webhook-secret'

describe('the E2E fixture’s signStripeWebhook', () => {
  it('a webhook signed by the fixture verifies against the real Stripe check', async () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      created: 1_700_000_000,
      data: { object: { id: 'sub_1', status: 'active' } },
    })

    const header = await signStripeWebhook(body, SECRET)
    const result = await verifyStripeSignature(body, header, SECRET)

    expect(result).toEqual({ valid: true })
  })

  it('a body tampered with after signing fails the real Stripe check', async () => {
    const body = '{"type":"customer.subscription.updated","data":{"object":{"id":"sub_1"}}}'
    const header = await signStripeWebhook(body, SECRET)

    const result = await verifyStripeSignature(`${body} `, header, SECRET)

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature_mismatch')
  })

  it('signing with the wrong secret fails the real Stripe check', async () => {
    const body = '{"type":"customer.subscription.updated","data":{"object":{"id":"sub_1"}}}'
    const header = await signStripeWebhook(body, 'not-the-configured-secret')

    const result = await verifyStripeSignature(body, header, SECRET)

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature_mismatch')
  })
})
