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
// ── Filter by queue name ─────────────────────────────────────────────────────
// The hook fires for EVERY queue bound to this Worker, not just ours. Today
// there is one; the day a second is added, an unfiltered handler would try to
// parse its messages as email and dead-letter them. `batch.queue` is the
// configured queue name, so the check is cheap and permanent.
//
// ── Logging rule ─────────────────────────────────────────────────────────────
// Never the recipient alongside the body. This file handles the full rendered
// message for every email the app sends, which makes it the single easiest
// place in the codebase to dump a user's mail into Cloudflare Logs. Subject and
// status only — the same rule sendEmail() already follows.

import {
  classifyResendResponse,
  decideQueueOutcome,
  EMAIL_QUEUE_MAX_ATTEMPTS,
  EMAIL_QUEUE_NAME,
  EmailQueueMessageSchema,
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

async function deliver(message: EmailQueueMessage, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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
    if (typed.queue !== EMAIL_QUEUE_NAME) return

    // No event here — this is not a request. useRuntimeConfig() with no
    // argument returns the shared config, which Nitro built by applying
    // process.env at module load; on workerd that is populated from the Worker
    // env, so `wrangler secret put NUXT_RESEND_API_KEY` is visible.
    const config = useRuntimeConfig()
    const apiKey = config.resend.apiKey

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

      const status = await deliver(parsed.data, apiKey)
      const decision = decideQueueOutcome(
        classifyResendResponse(status),
        message.attempts,
        EMAIL_QUEUE_MAX_ATTEMPTS,
      )

      if (decision.outcome !== 'sent') {
        console.error(
          JSON.stringify({
            kind:
              decision.outcome === 'permanent'
                ? 'email_queue_dead_letter'
                : decision.final
                  ? 'email_queue_final_attempt'
                  : 'email_queue_retry',
            // Subject and status only. Never `to`, never the body.
            subject: parsed.data.request.subject,
            status,
            attempts: message.attempts,
          }),
        )
      }

      if (decision.action === 'ack') message.ack()
      else message.retry()
    }
  })
})
