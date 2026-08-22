// The EMAIL_QUEUE consumer.
//
// ── Why this is a plugin and not a Worker entry ──────────────────────────────
// Nitro's `cloudflare_module` preset already exports a `queue()` handler
// (nitropack/dist/presets/cloudflare/runtime/_module-handler.mjs). All it does
// is `context.waitUntil(nitroApp.hooks.callHook('cloudflare:queue', { batch,
// env, context }))`. So the consumer is a runtime hook, and this template needs
// no custom entry point — which matters, because a hand-written entry would
// have to re-export `fetch` and `scheduled` too and would silently rot the next
// time Nitro changes either.
//
// The same is true of `scheduled` (see server/tasks/purge-expired-tokens.ts),
// `email`, `tail` and `trace`: all five are already wired to hooks.
//
// ── This handler MUST keep waiting for waitUntil ─────────────────────────────
// The preset's `queue()` returns synchronously and only `waitUntil`s the hook,
// so every `ack()` and `retry()` below runs AFTER the handler has returned.
// That is safe purely because of Cloudflare's default: a queue consumer does
// not acknowledge a batch until the promises passed to `ctx.waitUntil()` have
// resolved.
//
// The `queue_consumer_no_wait_for_wait_until` compatibility flag reverses that
// default. It is experimental with no enable date today, but if a future
// `compatibility_date` ever makes it default, this handler would return before
// a single decision was made, every batch would be acked immediately, and
// `retry()` would become a no-op — mail lost silently, with the logs still
// cheerfully reporting retries. `wrangler.toml` therefore pins the disable
// flag `queue_consumer_wait_for_wait_until` in `compatibility_flags`. Do not
// remove it, and do not "fix" it by making the hook synchronous.
//
// ── Filter by queue name ─────────────────────────────────────────────────────
// The hook fires for EVERY queue bound to this Worker, not just ours. The
// expected name comes from runtime config rather than a constant — see
// shouldHandleQueue(), where the preview outage that caused this is written up.
// A batch from an unexpected queue is LOGGED and skipped, never silently
// returned from: skipping without acking implicitly acks the whole batch.
//
// ── Logging rule ─────────────────────────────────────────────────────────────
// Never the recipient alongside the body. This file handles the full rendered
// message for every email the app sends, which makes it the single easiest
// place in the codebase to dump a user's mail into Cloudflare Logs. Subject and
// status only — the same rule sendEmail() already follows.
//
// The DEAD-LETTER QUEUE does not get that protection, and it cannot: a
// dead-lettered message is the whole rendered email, so `my-app-email-dlq`
// holds recipient addresses and full message bodies at rest, readable by
// anyone with account access. Treat it as a PII store — drain it, do not let
// it accumulate, and remember it when answering a deletion request.

import {
  classifyResendResponse,
  decideQueueOutcome,
  EMAIL_FAILURE_KIND,
  EMAIL_QUEUE_MAX_ATTEMPTS,
  EmailQueueMessageSchema,
  shouldHandleQueue,
} from '../utils/email-queue'
import type { EmailQueueMessage } from '../utils/email-queue'

/** The slice of Cloudflare's `Message` we use. */
interface QueueMessageLike {
  id: string
  body: unknown
  attempts: number
  ack(): void
  retry(): void
}

interface QueueBatchLike {
  queue: string
  messages: readonly QueueMessageLike[]
}

/**
 * POST one message to Resend and report the status (or null if fetch threw).
 *
 * ── Idempotency-Key ──────────────────────────────────────────────────────────
 * `messageId` is the queue message id, which is stable across redeliveries —
 * that is exactly what makes it the right key. Without it, any attempt that
 * Resend ACCEPTED but we failed to observe sends the email twice: a fetch
 * timeout after Resend already took the message, or the isolate being evicted
 * between the 200 and `ack()`. Both retry, and both would deliver a duplicate.
 *
 * Resend honours the key for 24 hours, comfortably longer than four attempts
 * can span. It also makes a manual re-drive of the dead-letter queue safe:
 * replaying a DLQ message re-sends the same key, so anything that did get
 * through is deduplicated instead of arriving a second time.
 */
async function deliver(
  message: EmailQueueMessage,
  apiKey: string,
  messageId: string,
): Promise<number | null> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': messageId,
      },
      body: JSON.stringify(message.request),
    })
    return res.status
  } catch (error) {
    console.warn(
      JSON.stringify({
        kind: 'email_queue_fetch_failed',
        subject: message.request.subject,
        error: String(error),
      }),
    )
    // null is "fetch threw", which classifyResendResponse treats as transient.
    return null
  }
}

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('cloudflare:queue', async ({ batch }) => {
    const typed = batch as unknown as QueueBatchLike

    // No event here — this is not a request. useRuntimeConfig() with no
    // argument returns the shared config, which Nitro built by applying
    // process.env at module load; on workerd that is populated from the Worker
    // env, so `wrangler secret put NUXT_RESEND_API_KEY` is visible.
    const config = useRuntimeConfig()
    const apiKey = config.resend.apiKey

    if (!shouldHandleQueue(typed.queue, config.emailQueueName)) {
      // Logged rather than returned silently. Returning here acks the batch by
      // omission, so a name mismatch used to destroy mail without a trace —
      // which is precisely how the preview environment lost every email.
      console.warn(
        JSON.stringify({
          kind: 'email_queue_unexpected_queue',
          queue: typed.queue,
          expected: config.emailQueueName,
          messages: typed.messages.length,
        }),
      )
      return
    }

    for (const message of typed.messages) {
      const parsed = EmailQueueMessageSchema.safeParse(message.body)
      if (!parsed.success) {
        // Unparseable means a message this build cannot understand — a body
        // written by an older deploy whose shape changed, or corruption.
        // Retrying re-runs the same parse, so ack and record it. `v` exists to
        // keep this branch empty across a rollout; if it ever fires, the last
        // deploy changed the schema without bumping it.
        console.error(
          JSON.stringify({
            kind: 'email_queue_unparseable',
            id: message.id,
            attempts: message.attempts,
          }),
        )
        message.ack()
        continue
      }

      if (!apiKey) {
        // Configured when enqueued, unset now — a secret was rotated out mid
        // flight. Retry: this is transient in the only sense that matters, and
        // the DLQ is the right destination if it stays broken.
        console.error(JSON.stringify({ kind: 'email_queue_unconfigured', id: message.id }))
        message.retry()
        continue
      }

      const status = await deliver(parsed.data, apiKey, message.id)
      const decision = decideQueueOutcome(
        classifyResendResponse(status),
        message.attempts,
        EMAIL_QUEUE_MAX_ATTEMPTS,
      )

      if (decision.outcome !== 'sent') {
        console.error(
          JSON.stringify({
            // Same two kinds the inline path uses for the same statuses.
            kind: EMAIL_FAILURE_KIND[decision.outcome],
            path: 'queue',
            // Subject and status only. Never `to`, never the body.
            subject: parsed.data.request.subject,
            status,
            attempts: message.attempts,
            // `dropped` says this message is gone for good and did NOT reach
            // the dead-letter queue — acking is what keeps it out. The old
            // `email_queue_dead_letter` kind claimed the opposite and sent
            // people looking in a DLQ that never had it.
            ...(decision.outcome === 'permanent' ? { dropped: true } : { final: decision.final }),
          }),
        )
      }

      if (decision.action === 'ack') message.ack()
      else message.retry()
    }
  })
})
