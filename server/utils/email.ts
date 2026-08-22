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
//
// ── List-Unsubscribe ──────────────────────────────────────────────────────
// `unsubscribe` is the one option here that is refused rather than trusted.
// Gmail and Yahoo require List-Unsubscribe / List-Unsubscribe-Post on bulk
// mail, but that header must never appear on billing or security email — an
// inbox that can one-click-suppress "your payment failed" is worse than one
// that never told you. sendEmail() re-checks isMandatoryNotification() itself
// rather than trusting every call site to have checked first: a hardcoded
// allowlist is only as strong as its weakest caller, so the enforcement lives
// here too, one layer closer to the wire, not only in the reader
// (server/utils/notifications.ts) that decides whether to call sendEmail at
// all.
//
// It IGNORES a mandatory unsubscribe request rather than throwing, matching
// this file's own "never throws" rule: a caller passing one by mistake is a
// bug to fix, not a reason to fail a send that's more important than the
// bug. It logs loudly instead, because a silently dropped header is
// otherwise invisible — the email still sends, still looks right in an
// inbox, and only a mailbox provider's postmaster tools would ever have shown
// the gap.

// Explicit, not the Nitro auto-import: this file is loaded directly by
// test/email.test.ts, where nothing is injected.
import { isMandatoryNotification } from '#shared/utils/notifications'

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  /** Plain-text alternative. Always send one — it's what spam filters read. */
  text: string
  replyTo?: string
  /**
   * Attaches List-Unsubscribe / List-Unsubscribe-Post headers and a footer
   * line to the html/text bodies. `eventType` is checked against
   * isMandatoryNotification() before any of that happens — see the file
   * header.
   */
  unsubscribe?: { eventType: string; url: string }
}

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: 'unconfigured' | 'rejected' | 'error' }

/** The exact JSON body sendEmail() POSTs to Resend. */
export interface ResendEmailRequest {
  from: string
  to: string[]
  subject: string
  html: string
  text: string
  reply_to?: string
  headers?: Record<string, string>
}

function appendUnsubscribeToText(text: string, url: string): string {
  return `${text}\n\n—\nDon't want these? Unsubscribe: ${url}`
}

function appendUnsubscribeToHtml(html: string, url: string): string {
  const footer = `<p style="margin:16px 0 0 0;font-size:12px;color:#a8a29e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">Don't want these? <a href="${url}" style="color:#a8a29e;">Unsubscribe</a></p>`
  // Insert before the closing tag rather than append after it — appending
  // after `</body></html>` is invalid HTML that some mail clients render
  // literally as trailing text instead of as part of the message.
  return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : `${html}${footer}`
}

/**
 * Pure: turns SendEmailOptions into the exact body sendEmail() POSTs to
 * Resend, including the mandatory-type refusal. No network, no runtime
 * config — so test/email.test.ts can assert the List-Unsubscribe wiring
 * (and that it never reaches a mandatory event type) without mocking fetch.
 */
export function buildResendEmailRequest(opts: SendEmailOptions, from: string): ResendEmailRequest {
  const unsubscribe =
    opts.unsubscribe && !isMandatoryNotification(opts.unsubscribe.eventType)
      ? opts.unsubscribe
      : null

  if (opts.unsubscribe && !unsubscribe) {
    console.warn(
      JSON.stringify({
        kind: 'unsubscribe_header_blocked_mandatory',
        eventType: opts.unsubscribe.eventType,
        subject: opts.subject,
      }),
    )
  }

  return {
    from,
    to: [opts.to],
    subject: opts.subject,
    html: unsubscribe ? appendUnsubscribeToHtml(opts.html, unsubscribe.url) : opts.html,
    text: unsubscribe ? appendUnsubscribeToText(opts.text, unsubscribe.url) : opts.text,
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    ...(unsubscribe
      ? {
          headers: {
            'List-Unsubscribe': `<${unsubscribe.url}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      : {}),
  }
}

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
      body: JSON.stringify(buildResendEmailRequest(opts, from)),
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
