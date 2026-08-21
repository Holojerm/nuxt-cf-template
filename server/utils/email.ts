// Transactional email via Resend, over plain fetch.
//
// No SDK, for the same reason server/utils/posthog.ts has none: the Resend node
// SDK drags in node built-ins that need shimming on workerd, and the API is one
// POST. Swapping providers (Postmark, SES, MailChannels) means editing the URL
// and body in sendEmail() and nothing else — the templates and call sites are
// provider-agnostic.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Every call site is something more important than the email: a sign-in, a
// Paddle webhook that must return 200 or get retried forever. A bounced welcome
// email must not 500 a login, and a flaky mail API must not make Paddle replay a
// subscription event. Failures are logged and reported; the return value tells
// you what happened if you care.
//
// Unconfigured (no NUXT_RESEND_API_KEY) = no-op with a debug line, so the
// template runs end-to-end without a Resend account.

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  /** Plain-text alternative. Always send one — it's what spam filters read. */
  text: string
  replyTo?: string
}

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: 'unconfigured' | 'rejected' | 'error' }

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const config = useRuntimeConfig()
  const apiKey = config.resend.apiKey
  const from = config.resend.from

  if (!apiKey || !from) {
    console.info(
      JSON.stringify({ kind: 'email_skipped', reason: 'unconfigured', subject: opts.subject }),
    )
    return { sent: false, reason: 'unconfigured' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    })

    if (!res.ok) {
      // Log the status and Resend's message, never the recipient's address
      // alongside the body — logs are the easiest place to leak PII by accident.
      const detail = await res.text().catch(() => '')
      console.error(
        JSON.stringify({
          kind: 'email_rejected',
          status: res.status,
          subject: opts.subject,
          detail: detail.slice(0, 300),
        }),
      )
      return { sent: false, reason: 'rejected' }
    }

    const body = (await res.json().catch(() => null)) as { id?: string } | null
    return { sent: true, id: body?.id ?? null }
  } catch (error) {
    console.error(
      JSON.stringify({ kind: 'email_error', subject: opts.subject, error: String(error) }),
    )
    return { sent: false, reason: 'error' }
  }
}
