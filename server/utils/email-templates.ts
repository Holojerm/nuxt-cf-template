// The transactional emails this app sends, as plain functions returning
// { subject, html, text }. The wording is in emails/templates/<name>.vue and
// its .txt sibling — Maizzle compiles those at build time into
// server/emails/generated.ts, and renderEmail() fills in the data. What stays
// here is what a template cannot do: the subject lines, and turning a Date or an
// enum into the strings a template reads. See .claude/docs/email.md.
//
// Every email ships a real plain-text alternative. Spam filters read it, and so
// do the people who turned HTML off.
//
// Names come from OAuth providers, which means they're attacker-controllable —
// "Ada <script>" is a valid GitHub display name. They reach the template as
// data, and renderEmail() escapes data.

import { renderEmail, type EmailName } from './render-email'

export interface EmailContent {
  subject: string
  html: string
  text: string
}

export interface Branding {
  appName: string
  appUrl: string
}

/**
 * Subject in TypeScript, body from the compiled template of the same name.
 * Exported for the other template files (auth, account, lifecycle) so each does
 * not spell out the same brand-merging again.
 */
export function composeEmail(
  name: EmailName,
  subject: string,
  brand: Branding,
  data: Record<string, unknown> = {},
): EmailContent {
  return {
    subject,
    ...renderEmail(name, { appName: brand.appName, appUrl: brand.appUrl, ...data }),
  }
}

const longDate = (date: Date) =>
  date.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })

/** First sign-in. Short on purpose — nobody reads a welcome tour. */
export function welcomeEmail(brand: Branding, opts: { name: string }): EmailContent {
  return composeEmail('welcome', `Welcome to ${brand.appName}`, brand, { name: opts.name })
}

/** Money changed hands. Paddle sends the tax receipt; this confirms access. */
export function purchaseEmail(
  brand: Branding,
  opts: { name: string; kind: 'subscription' | 'pass'; endsAt: Date | null },
): EmailContent {
  const isPass = opts.kind === 'pass'
  return composeEmail(
    'purchase',
    isPass
      ? `Your ${brand.appName} pass is active`
      : `Your ${brand.appName} subscription is active`,
    brand,
    { name: opts.name, isPass, ends: opts.endsAt ? longDate(opts.endsAt) : null },
  )
}

/** A card failed. The only email here with real urgency, so it says the deadline. */
export function paymentFailedEmail(brand: Branding, opts: { name: string }): EmailContent {
  return composeEmail(
    'payment-failed',
    `Action needed: payment failed for ${brand.appName}`,
    brand,
    { name: opts.name },
  )
}

/** Access ended — cancellation, refund, or chargeback. Never argumentative. */
export function accessEndedEmail(
  brand: Branding,
  opts: { name: string; reason: 'canceled' | 'refunded' | 'chargeback' | 'comp_revoked' },
): EmailContent {
  return composeEmail('access-ended', `Your ${brand.appName} access has ended`, brand, {
    name: opts.name,
    canceled: opts.reason === 'canceled',
    refunded: opts.reason === 'refunded',
    chargeback: opts.reason === 'chargeback',
    compRevoked: opts.reason === 'comp_revoked',
  })
}

/**
 * A human reply to something someone sent through the feedback widget.
 *
 * The only email here that isn't triggered by a state change — it exists
 * because feedback with no return path is extraction rather than a loop. Sent
 * from POST /api/feedback/[id]/reply, which is admin-gated; the triage routine
 * is explicitly forbidden from calling it.
 *
 * `originalMessage` is untrusted text written by anyone on the internet. It is
 * safe here only because the template renders it as a {{double}} tag, which
 * renderEmail() escapes — a {{{triple}}} there would build an HTML-injection
 * vector into your own outbound mail.
 */
export function feedbackReplyEmail(
  brand: Branding,
  opts: { reply: string; originalMessage: string },
): EmailContent {
  // Quoted back because the reply may land weeks later, and nobody remembers
  // what they typed into a widget.
  const quoted =
    opts.originalMessage.length > 600
      ? `${opts.originalMessage.slice(0, 600)}…`
      : opts.originalMessage

  return composeEmail('feedback-reply', `Re: your feedback on ${brand.appName}`, brand, {
    reply: opts.reply,
    quoted,
  })
}

/** Pull app name + absolute URL out of runtime config for the templates above. */
export function emailBranding(): Branding {
  const config = useRuntimeConfig()
  return {
    appName: config.public.appName,
    // Trailing slashes turn every link into `//account`. Strip once, here.
    appUrl: (config.public.appUrl || '').replace(/\/+$/, ''),
  }
}
