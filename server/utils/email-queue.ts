// The seam between sendEmail() and Cloudflare Queues.
//
// Moving mail off the request path means a Paddle webhook no longer pays
// Resend's latency inline, and a transient Resend failure is retried by the
// platform instead of dropped (sendEmail() never throws and held no message).
//
// Cost: the caller stops learning whether THIS address was accepted; per-address
// refusals surface in the consumer's logs. Only magic-link.post.ts inspects
// `rejected`, and it already answers it identically to success (no enumeration
// oracle). The magic link, the one email a user waits on, gains queue latency,
// hence `max_batch_timeout = 1` in `[[queues.consumers]]`. The unconfigured-
// Resend check happens BEFORE the enqueue, so no provider still fails fast.
//
// Mandatory-mail policy is decided upstream: the message is the OUTPUT of
// buildResendEmailRequest(), after isMandatoryNotification() has run and
// List-Unsubscribe was attached or refused. The consumer POSTs bytes and must
// not decide policy (a rule enforced in two places drifts in one). The message
// also carries no credential: the consumer reads the Resend key from runtime
// config at delivery time. Do not add it to "save a lookup".

import { z } from 'zod'

/** Binding name — must match `binding` in `[[queues.producers]]`. */
export const EMAIL_QUEUE_BINDING = 'EMAIL_QUEUE'

/**
 * MUST equal `max_retries` **+ 1** in the `[[queues.consumers]]` block:
 * `max_retries` counts RETRIES, so `message.attempts` runs 1…max_retries+1
 * (miniflare's broker computes `maxAttempts = maxRetries + 1`); set to
 * `max_retries`, `final` was true a delivery early. Cloudflare owns the cap
 * (`retry()` on the final attempt moves a message to the DLQ); this only lets
 * the consumer log "last attempt". A number duplicated from wrangler.toml, like
 * NATIVE_LIMITER in rate-limit.ts.
 */
export const EMAIL_QUEUE_MAX_ATTEMPTS = 4

/**
 * What the queue carries: exactly the JSON body sendEmail() would have POSTed.
 * `v` is a schema version: a queue holds messages written by the PREVIOUS
 * deploy, and without it the consumer would dead-letter a backlog of good mail
 * parsed against a new schema.
 */
export const EmailQueueMessageSchema = z.object({
  v: z.literal(1),
  /** Unix milliseconds, for a delivery-lag line in the consumer's log. */
  enqueuedAt: z.number().int(),
  request: z.object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    reply_to: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
})

export type EmailQueueMessage = z.infer<typeof EmailQueueMessageSchema>

/** The slice of Cloudflare's `Queue` we use — lets tests pass a fake. */
export interface EmailQueueProducer {
  send(body: unknown): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The producer binding off the Worker env, or undefined. Takes no H3Event
 * (sendEmail() runs in webhooks and tasks too). The three-way lookup mirrors
 * NuxtHub's own `db` binding: `process.env` under `nodejs_compat`,
 * `globalThis.__env__` (assigned by Nitro's handlers), and the bare global. The
 * `typeof send === 'function'` check is what proves a binding exists; without
 * one, a fork gets an inline send, not a TypeError.
 */
export function resolveEmailQueue(): EmailQueueProducer | undefined {
  // Via `unknown`, not ambient `process` types: test/email-queue.test.ts loads this directly.
  const globals = globalThis as unknown as Record<string, unknown>
  const processEnv = isRecord(globals.process) ? globals.process.env : undefined

  const candidates = [
    isRecord(processEnv) ? processEnv[EMAIL_QUEUE_BINDING] : undefined,
    isRecord(globals.__env__) ? globals.__env__[EMAIL_QUEUE_BINDING] : undefined,
    globals[EMAIL_QUEUE_BINDING],
  ]

  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.send === 'function') {
      return candidate as unknown as EmailQueueProducer
    }
  }
  return undefined
}

/**
 * Should this send go through the queue? Pure, for testing every combination.
 *
 * `dev` is a hard no: `nuxt dev` has a fetch handler and no `queue()` export, so
 * nothing drains, yet getPlatformProxy() hands it a working producer. Enqueuing
 * would report `sent: true` for mail that never exists, indistinguishable from
 * a Resend outage.
 */
export function shouldUseEmailQueue(
  queue: EmailQueueProducer | undefined,
  dev: boolean,
): queue is EmailQueueProducer {
  return !dev && queue !== undefined
}

/** How the Resend POST ended. Same vocabulary on both delivery paths. */
export type DeliveryOutcome = 'sent' | 'permanent' | 'transient'

/**
 * The log `kind` for a failed send, shared by both paths so one status is not
 * described two ways (an inline 503 once logged `email_rejected`, the same 503
 * in the consumer `email_queue_retry`). The path is a FIELD (`path: 'inline' |
 * 'queue'`): one query covers both.
 */
export const EMAIL_FAILURE_KIND = {
  permanent: 'email_permanent_failure',
  transient: 'email_transient_failure',
} as const satisfies Record<Exclude<DeliveryOutcome, 'sent'>, string>

/**
 * Classify a Resend response so the retry decision is made on facts. `null`
 * (fetch threw: DNS, TLS, dropped connection) is transient. 429 groups with 5xx:
 * it means "later", and a burst of queued mail provokes it. Any other 4xx is the
 * message itself being wrong and fails identically every attempt.
 *
 * Both paths use it; sendEmail() maps `permanent` to `rejected` (this message)
 * and `transient` to `error` (the provider), which lets magic-link tell "cannot
 * send mail now" from "that address bounced". Before, every non-2xx was
 * `rejected` and a Resend outage read as a delivered link.
 */
export function classifyResendResponse(status: number | null): DeliveryOutcome {
  if (status === null) return 'transient'
  if (status >= 200 && status < 300) return 'sent'
  if (status === 429 || status >= 500) return 'transient'
  return 'permanent'
}

export interface QueueDecision {
  /** `retry()` on the last attempt is what routes a message to the DLQ. */
  action: 'ack' | 'retry'
  outcome: DeliveryOutcome
  /** True when this attempt was the last one before the dead-letter queue. */
  final: boolean
}

/**
 * Should this consumer handle a batch from `queue`? The expected name is
 * runtime config, not a constant: `[env.preview]` names the queue differently,
 * a baked-in constant never matched there, and the consumer returned without
 * acking, implicitly acking (destroying) every preview email with no log. A
 * `vars` entry tracks the environment (`[env.preview.vars]` replaces the block).
 * An UNSET name accepts every batch: with one consumer, delivering beats silently
 * dropping. A fork adding a second queue sets the var.
 */
export function shouldHandleQueue(batchQueue: string, expected: string | undefined): boolean {
  if (!expected) return true
  return batchQueue === expected
}

/**
 * What to do with one message, given how its delivery went. Pure: the consumer
 * does the I/O, this decides. `permanent` acks (logged `dropped: true`, never
 * reaching the DLQ): the DLQ is for messages that MIGHT still be deliverable,
 * and retrying costs three attempts to learn the same thing.
 */
export function decideQueueOutcome(
  outcome: DeliveryOutcome,
  attempt: number,
  maxAttempts: number = EMAIL_QUEUE_MAX_ATTEMPTS,
): QueueDecision {
  const final = attempt >= maxAttempts
  if (outcome === 'sent') return { action: 'ack', outcome, final }
  if (outcome === 'permanent') return { action: 'ack', outcome, final }
  return { action: 'retry', outcome, final }
}
