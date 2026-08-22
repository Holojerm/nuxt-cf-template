// The queue seam on outbound mail.
//
// Two halves, tested the way each one deserves. The retry/dead-letter decision
// and the response classifier are pure functions, so they get direct assertions
// — the same shape as decideNotification() in test/billing-notifications.test.ts.
// The producer/inline selection is driven through sendEmail() itself with a
// fake binding, because the property that matters there is not "the function
// returns the right enum", it is "the message ends up in exactly one of the two
// places, and never in neither".

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildResendEmailRequest, sendEmail } from '../server/utils/email'
import type { SendEmailOptions } from '../server/utils/email'
import {
  classifyResendResponse,
  decideQueueOutcome,
  EMAIL_QUEUE_BINDING,
  EMAIL_QUEUE_MAX_ATTEMPTS,
  EmailQueueMessageSchema,
  resolveEmailQueue,
  shouldHandleQueue,
  shouldUseEmailQueue,
} from '../server/utils/email-queue'

const BASE: SendEmailOptions = {
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<!doctype html><html><body><p>Hi</p></body></html>',
  text: 'Hi',
}

const CONFIGURED = { resend: { apiKey: 'test-key', from: 'App <hello@example.com>' } }

/** A stand-in for the Cloudflare Queue binding. */
function fakeQueue(): { send: ReturnType<typeof vi.fn>; sent: unknown[] } {
  const sent: unknown[] = []
  const send = vi.fn(async (body: unknown) => {
    sent.push(body)
  })
  return { send, sent }
}

describe('resolveEmailQueue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds the binding on globalThis.__env__, where Nitro puts the Worker env', () => {
    const queue = fakeQueue()
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: queue })
    expect(resolveEmailQueue()).toBe(queue)
  })

  it('is undefined when nothing is bound — the template default, and dev', () => {
    expect(resolveEmailQueue()).toBeUndefined()
  })

  it('rejects a binding whose send is not callable, rather than throwing later', () => {
    // A fork that trimmed the queue out of wrangler.toml, or any non-Cloudflare
    // preset, must fall back to an inline send — not a TypeError inside a
    // function whose whole contract is that it never throws.
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: { send: 'not a function' } })
    expect(resolveEmailQueue()).toBeUndefined()
  })
})

describe('shouldUseEmailQueue', () => {
  const queue = { send: async () => {} }

  it('uses the queue when a binding exists outside dev', () => {
    expect(shouldUseEmailQueue(queue, false)).toBe(true)
  })

  it('never uses the queue in dev, even though miniflare provides a binding', () => {
    // `nuxt dev` has a producer (via getPlatformProxy) but no consumer — the
    // dev preset exports no queue() handler. Enqueueing there is a black hole
    // that reports success.
    expect(shouldUseEmailQueue(queue, true)).toBe(false)
  })

  it('sends inline when there is no binding at all', () => {
    expect(shouldUseEmailQueue(undefined, false)).toBe(false)
  })
})

describe('shouldHandleQueue', () => {
  // The bug this function exists for: the expected name used to be a
  // compile-time constant equal to the PRODUCTION queue, so in preview the
  // consumer skipped every batch — and skipping without acking acks the batch
  // by omission, so all preview mail was destroyed with no log line.
  it('handles the production queue when configured for production', () => {
    expect(shouldHandleQueue('my-app-email', 'my-app-email')).toBe(true)
  })

  it('handles the PREVIEW queue when configured for preview', () => {
    expect(shouldHandleQueue('my-app-email-preview', 'my-app-email-preview')).toBe(true)
  })

  it('does not treat the preview queue as the production one', () => {
    // Exactly the mismatch a constant produced, and the reason `bun run rename`
    // could not fix it: `<name>-email` and `<name>-email-preview` differ.
    expect(shouldHandleQueue('my-app-email-preview', 'my-app-email')).toBe(false)
  })

  it('accepts every batch when the name is unconfigured', () => {
    // One consumer is configured, so delivering beats dropping silently.
    expect(shouldHandleQueue('anything', '')).toBe(true)
    expect(shouldHandleQueue('anything', undefined)).toBe(true)
  })
})

describe('classifyResendResponse', () => {
  it.each([200, 202])('treats %i as sent', (status) => {
    expect(classifyResendResponse(status)).toBe('sent')
  })

  it.each([500, 502, 503])('treats %i as transient', (status) => {
    expect(classifyResendResponse(status)).toBe('transient')
  })

  it('treats a thrown fetch (null) as transient', () => {
    expect(classifyResendResponse(null)).toBe('transient')
  })

  it('treats 429 as transient, not as a client error', () => {
    // The one 4xx that means "later" — and exactly the status a drained backlog
    // provokes. Classifying it as permanent would discard the whole queue at
    // the moment it is doing its job.
    expect(classifyResendResponse(429)).toBe('transient')
  })

  it.each([400, 401, 403, 422])('treats %i as permanent', (status) => {
    expect(classifyResendResponse(status)).toBe('permanent')
  })
})

describe('decideQueueOutcome', () => {
  it('acks a delivered message', () => {
    expect(decideQueueOutcome('sent', 1)).toEqual({ action: 'ack', outcome: 'sent', final: false })
  })

  it('retries a transient failure while attempts remain', () => {
    expect(decideQueueOutcome('transient', 1)).toMatchObject({ action: 'retry', final: false })
  })

  it('still retries on the final attempt — that is what reaches the DLQ', () => {
    // Cloudflare owns the cap: retry() on the last attempt is the ONLY way a
    // message lands in the dead-letter queue. Acking here would silently drop
    // exactly the mail worth inspecting.
    const decision = decideQueueOutcome('transient', EMAIL_QUEUE_MAX_ATTEMPTS)
    expect(decision.action).toBe('retry')
    expect(decision.final).toBe(true)
  })

  it('counts deliveries, not retries — `final` is false on max_retries', () => {
    // The off-by-one this constant was born with. `max_retries = 3` means the
    // message is DELIVERED up to four times (miniflare: `maxAttempts =
    // maxRetries + 1`), so attempt 3 is not the last one and must not be
    // logged as such.
    expect(EMAIL_QUEUE_MAX_ATTEMPTS).toBe(4)
    expect(decideQueueOutcome('transient', 3).final).toBe(false)
    expect(decideQueueOutcome('transient', 4).final).toBe(true)
  })

  it('acks a permanent rejection instead of burning attempts on it', () => {
    // A 4xx fails identically three times. The consumer logs it as a dead
    // letter; the DLQ is for messages that might still be deliverable.
    expect(decideQueueOutcome('permanent', 1)).toMatchObject({ action: 'ack', final: false })
  })
})

describe('EmailQueueMessageSchema', () => {
  it('accepts what buildResendEmailRequest produces, headers and all', () => {
    const url = 'https://example.com/api/email/unsubscribe?u=user-1&e=welcome&t=abc'
    const request = buildResendEmailRequest(
      { ...BASE, replyTo: 'help@example.com', unsubscribe: { eventType: 'welcome', url } },
      'App <hello@example.com>',
    )

    const parsed = EmailQueueMessageSchema.safeParse({ v: 1, enqueuedAt: Date.now(), request })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.request.headers?.['List-Unsubscribe']).toBe(`<${url}>`)
  })

  it('rejects a body from a different schema version', () => {
    // The branch that keeps a rollout from dead-lettering in-flight mail: a
    // message written by the previous deploy must be recognisably not-this.
    const request = buildResendEmailRequest(BASE, 'App <hello@example.com>')
    expect(EmailQueueMessageSchema.safeParse({ v: 2, enqueuedAt: 0, request }).success).toBe(false)
  })

  it('carries no API key — the consumer reads that from runtime config', () => {
    const request = buildResendEmailRequest(BASE, 'App <hello@example.com>')
    const serialized = JSON.stringify({ v: 1, enqueuedAt: 0, request })
    expect(serialized).not.toContain('test-key')
    expect(serialized.toLowerCase()).not.toContain('authorization')
  })
})

describe('sendEmail — producer vs inline', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('enqueues instead of POSTing when the binding is present', async () => {
    const queue = fakeQueue()
    const fetchMock = vi.fn()
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: queue })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    const result = await sendEmail(BASE)

    expect(result).toEqual({ sent: true, id: null, queued: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queue.sent).toHaveLength(1)
    // What lands on the queue is the built request, not the options — the
    // unsubscribe policy has already been applied and must not be re-decided.
    const parsed = EmailQueueMessageSchema.parse(queue.sent[0])
    expect(parsed.request.to).toEqual(['ada@example.com'])
    expect(parsed.request.from).toBe('App <hello@example.com>')
  })

  it('POSTs inline when no queue is bound', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'email_123' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    const result = await sendEmail(BASE)

    expect(result).toEqual({ sent: true, id: 'email_123' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to an inline send when the enqueue itself fails', async () => {
    // Queues has its own limits and outages. Adding it must not have made any
    // call site less reliable than it was before the queue existed.
    const send = vi.fn(async () => {
      throw new Error('queue unavailable')
    })
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'email_fallback' }), { status: 200 }),
    )
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: { send } })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    const result = await sendEmail(BASE)

    expect(result).toEqual({ sent: true, id: 'email_fallback' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('`inline: true` bypasses the queue even though a binding exists', async () => {
    // The opt-out for callers whose contract is "sent, or an error": the
    // magic-link endpoint owes a 503 it cannot produce from an enqueue, and
    // the feedback reply stamps `replied_at` on success.
    const queue = fakeQueue()
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'email_inline' }), { status: 200 }),
    )
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: queue })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    const result = await sendEmail({ ...BASE, inline: true })

    expect(result).toEqual({ sent: true, id: 'email_inline' })
    expect(queue.sent).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a provider outage as `error`, not `rejected`', async () => {
    // Both paths now share classifyResendResponse. A 503 is the provider being
    // unwell, not this address being refused — and magic-link answers
    // `rejected` with 200 (to avoid an enumeration oracle), so misclassifying
    // an outage told the user their sign-in link was on its way.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 503 })),
    )
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    expect(await sendEmail(BASE)).toEqual({ sent: false, reason: 'error' })
  })

  it('still reports a per-message 4xx as `rejected`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad from', { status: 422 })),
    )
    vi.stubGlobal('useRuntimeConfig', () => CONFIGURED)

    expect(await sendEmail(BASE)).toEqual({ sent: false, reason: 'rejected' })
  })

  it('checks configuration before the queue, so unconfigured never enqueues', async () => {
    // Otherwise a deployment with no Resend key would fill a queue with mail
    // nothing can ever send, and magic-link sign-in would answer 200 instead
    // of the 503 it owes the caller.
    const queue = fakeQueue()
    vi.stubGlobal('__env__', { [EMAIL_QUEUE_BINDING]: queue })
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('useRuntimeConfig', () => ({ resend: { apiKey: '', from: '' } }))

    const result = await sendEmail(BASE)

    expect(result).toEqual({ sent: false, reason: 'unconfigured' })
    expect(queue.sent).toHaveLength(0)
  })
})
