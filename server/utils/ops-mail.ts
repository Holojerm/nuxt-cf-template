// The transport half of ops alerting. Kept apart from server/utils/ops.ts so
// the drain logic stays pure and testable — this file is the only thing that
// knows about a Cloudflare binding.
//
// The bindings arrive as an argument rather than through an import. Nitro's
// cloudflare-module handler calls `runCronTasks(cron, { context: { cloudflare:
// { env, context } } })`, so a scheduled task is handed the same `env` a fetch
// handler gets. That beats importing `cloudflare:workers`, which types don't
// resolve for under Nuxt's generated server tsconfig.
//
// Why the `send_email` binding and not Resend: the binding delivers to a
// *verified destination address* for free with no sending-domain onboarding,
// which is exactly right for mailing yourself and useless for mailing a
// customer. The two transports are deliberately separate — see the `resend`
// block in nuxt.config.ts.

import type { OpsDigest, OpsMailer } from './ops'

/** The `send_email` binding's shape — only the call we make. */
interface SendEmailBinding {
  send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown>
}

/**
 * A mailer, or null when alerting isn't configured yet. Unconfigured is a setup
 * state rather than an error: the cron logs it once per tick and returns, so a
 * half-finished setup doesn't spool alerts about its own inability to alert.
 */
export function getOpsMailer(env: Record<string, unknown> | undefined): OpsMailer | null {
  const config = useRuntimeConfig()
  const to = config.alertEmailTo
  const from = config.alertEmailFrom
  const binding = env?.ALERT_EMAIL as SendEmailBinding | undefined

  if (!to || !from || !binding) return null

  return async (digest: OpsDigest) => {
    await binding.send({ to, from, subject: digest.subject, text: digest.text })
  }
}
