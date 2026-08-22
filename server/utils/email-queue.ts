// The seam between sendEmail() and Cloudflare Queues.
//
// ── What moving mail off the request path buys ───────────────────────────────
// Every sendEmail() call site is something more important than the email, and
// until now each of them paid Resend's latency inline and got one attempt. A
// Paddle webhook that must answer 200 in seconds was making a third-party API
// call to do it; a transient 503 from Resend meant the mail was simply gone,
// because sendEmail() never throws and nothing was holding the message.
//
// A queue fixes both: the producer send is a local binding call, and a failed
// delivery is retried by the platform instead of dropped.
//
// ── What it costs, stated plainly ────────────────────────────────────────────
// The caller stops learning whether THIS address was accepted. Resend's
// per-address refusals (suppression list, hard bounce, malformed domain) now
// surface in the consumer's logs rather than in the handler's return value.
// One call site cared: server/api/auth/magic-link.post.ts inspects `rejected`
// — and already answers it identically to success on purpose, to avoid an
// account-enumeration oracle, so its behaviour is unchanged.
//
// It also adds delivery latency to the magic link, which is the one email a
// user is actively waiting on. That is why `[[queues.consumers]]` sets
// `max_batch_timeout = 1` rather than taking the 30s default — see the comment
// there. The unconfigured-Resend check still happens BEFORE the enqueue, so a
// deployment with no mail provider still fails fast instead of queueing into
// nothing.
//
// ── Mandatory-mail semantics are decided upstream, deliberately ──────────────
// The message body is the OUTPUT of buildResendEmailRequest(), not its input.
// By the time anything is enqueued, isMandatoryNotification() has already run
// and List-Unsubscribe has either been attached or refused. The consumer POSTs
// bytes; it makes no policy decisions, and it must not start — a header rule
// enforced in two places drifts in one of them.
//
// The body also carries no credential. Resend authenticates with a bearer token
// in a header, which the consumer reads from runtime config at delivery time,
// so the queue never stores it. Do not add it to the message to "save a lookup".

import { z } from 'zod'

/** Binding name — must match `binding` in `[[queues.producers]]`. */
export const EMAIL_QUEUE_BINDING = 'EMAIL_QUEUE'

/**
 * MUST equal `max_retries` **+ 1** in the `[[queues.consumers]]` block.
 *
 * `max_retries` counts RETRIES, not deliveries: a message is handed to the
 * consumer once and then retried up to that many times, so `message.attempts`
 * runs 1…max_retries+1. (Confirmed in miniflare's queue broker, which computes
 * `maxAttempts = (consumer.maxRetries ?? DEFAULT_RETRIES) + 1`.) Setting this
 * to `max_retries` made `final` true on both the third and fourth delivery, so
 * `email_transient_failure` claimed "last attempt" a whole attempt early.
 *
 * Cloudflare owns the actual cap: calling `message.retry()` on the final
 * attempt is what moves a message to the dead-letter queue. This constant does
 * not enforce anything — it exists so the consumer can log "this was the last
 * one" at the moment it happens, instead of the message vanishing into the DLQ
 * with no line saying why. Same discipline as NATIVE_LIMITER in rate-limit.ts:
 * a number duplicated from wrangler.toml, and named so the duplication is
 * visible rather than a literal buried in a branch.
 */
export const EMAIL_QUEUE_MAX_ATTEMPTS = 4

/**
 * What the queue carries: exactly the JSON body sendEmail() would have POSTed.
 *
 * `v` is a schema version, and it earns its byte on the deploy where this shape
 * changes. A queue is the one place in the system holding messages written by
 * the PREVIOUS version of the code — in-flight and retrying across the rollout.
 * Without a version the consumer would parse an old body against a new schema
 * and dead-letter a backlog of perfectly good mail.
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
 * Pull the producer binding off the Worker env, or undefined when there is none.
 *
 * Unlike resolveNativeLimiter() in rate-limit.ts this takes no H3Event, because
 * sendEmail() has none — it is called from webhooks, from tasks, and from
 * request handlers alike. The three-way lookup is the same expression NuxtHub
 * generates for its own `db` binding: `process.env` is where workerd surfaces
 * bindings under `nodejs_compat`, `globalThis.__env__` is what Nitro's
 * cloudflare handlers assign on every fetch/scheduled/queue invocation, and the
 * bare global is the older shape.
 *
 * The `typeof send === 'function'` check is the only thing that actually proves
 * a binding is there, exactly as in rate-limit.ts: a fork that trimmed the
 * queue out of wrangler.toml, or any non-Cloudflare preset, lands here and gets
 * an inline send rather than a TypeError.
 */
export function resolveEmailQueue(): EmailQueueProducer | undefined {
  // Read through `unknown` rather than the ambient Node/workers globals: this
  // file is loaded directly by test/email-queue.test.ts, and depending on
  // `process` being declared would tie a runtime lookup to a type environment.
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
 * Should this send go through the queue?
 *
 * Pure, and takes both inputs explicitly so test/email-queue.test.ts can drive
 * every combination without a Worker.
 *
 * ── Why `dev` is a hard no, not a preference ─────────────────────────────────
 * `bun dev` is `nuxt dev`, which runs the `_nitro` dev preset — it has a fetch
 * handler and nothing else. There is no `queue()` export, so no consumer
 * exists. But wrangler's `getPlatformProxy()` reads the same wrangler.toml and
 * DOES hand the dev server a working producer binding, backed by miniflare.
 *
 * So without this check, a dev server with Resend configured would enqueue
 * every email into a local queue nothing ever drains: the send succeeds, the
 * handler returns `sent: true`, and the mail never exists. Silent, and
 * indistinguishable from a Resend outage from inside the app.
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
 * The log `kind` for a failed send, whichever path made it.
 *
 * Both paths POST to the same API and classify the response with the same
 * function, so they must not describe the same status with different words.
 * They previously did: an inline 503 logged `email_rejected` (which reads as
 * "the address was refused") while the same 503 in the consumer logged
 * `email_queue_retry`. Anyone grepping for mail failures found half of them.
 *
 * The path is a FIELD (`path: 'inline' | 'queue'`), not part of the kind, so
 * one query covers both and you can still split them when you want to.
 */
export const EMAIL_FAILURE_KIND = {
  permanent: 'email_permanent_failure',
  transient: 'email_transient_failure',
} as const satisfies Record<Exclude<DeliveryOutcome, 'sent'>, string>

/**
 * Classify a Resend response so the retry decision is made on facts.
 *
 * `null` means fetch itself threw — DNS, TLS, a dropped connection — which is
 * always worth another attempt.
 *
 * 429 is grouped with 5xx rather than with the other 4xx: it is the one status
 * in that range that means "later", and it is exactly the status a burst of
 * queued mail provokes. Treating it as permanent would throw away the whole
 * backlog at the moment the queue is doing its job.
 *
 * Every other 4xx is the message itself being wrong — an unverified `from`, a
 * suppressed recipient, a malformed body. Those fail identically on every
 * later attempt, so retrying only delays the log line that tells you what to
 * fix.
 *
 * Used by BOTH delivery paths. sendEmail()'s inline branch maps the result
 * onto its own vocabulary — `permanent` → `rejected` (this message is wrong),
 * `transient` → `error` (the provider is unwell) — which is what lets
 * magic-link's 503 branch distinguish "we cannot send mail right now" from
 * "that address bounced". Before this was shared, every non-2xx became
 * `rejected` and a Resend outage was reported to the user as a delivered link.
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
 * Should this consumer handle a batch from `queue`?
 *
 * ── Why the expected name is configuration and not a constant ────────────────
 * It was a constant, and that was a silent bug in preview. `[env.preview]`
 * names the queue `my-app-email-preview`, but a constant is baked into the
 * bundle once — so `batch.queue` never matched, the consumer returned before
 * acking or retrying anything, the batch was implicitly acked, and every
 * preview email vanished with no log line. `bun run rename` preserved the
 * mismatch rather than fixing it, because `<name>-email` and
 * `<name>-email-preview` are different strings.
 *
 * A `vars` entry survives NuxtHub's env flattening: the whole `vars` block is
 * replaced by `[env.preview.vars]` at build time, so the value tracks the
 * environment the way a compile-time constant cannot.
 *
 * An UNSET name accepts every batch, deliberately. This Worker configures
 * exactly one consumer, so delivering mail is strictly better than dropping it
 * silently — the failure this whole function exists to prevent. A fork that
 * later adds a second queue sets the var and gets filtering back.
 */
export function shouldHandleQueue(batchQueue: string, expected: string | undefined): boolean {
  if (!expected) return true
  return batchQueue === expected
}

/**
 * What to do with one message, given how its delivery went.
 *
 * Pure, and the whole point of the split: the consumer does I/O and this
 * decides, so the interesting half is testable without a queue or a network.
 *
 * `permanent` acks, and the consumer logs it with `dropped: true` because the
 * message never reaches the dead-letter queue — acking is what keeps it out.
 * Retrying to get it there would cost three more attempts to learn the same
 * thing, and the DLQ is for messages that MIGHT still be deliverable.
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
