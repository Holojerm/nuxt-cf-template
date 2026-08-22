// The transactional emails this app sends, as plain functions returning
// { subject, html, text }. Kept separate from server/utils/email.ts so the
// wording is reviewable in one place and testable without a network call.
//
// ── Why the HTML looks like 2004 ─────────────────────────────────────────────
// Email clients are not browsers. Outlook renders through Word, Gmail strips
// <style> blocks and CSS variables, and dark-mode inversion is per-client
// guesswork. So: one centered table, inline styles, hex colors, no web fonts,
// no external images. This is the one place in the codebase where DESIGN.md's
// token layer does not apply (design:check only scans app/), because there is
// no CSS cascade here to hang tokens on.
//
// Every email ships a real plain-text alternative. Spam filters read it, and so
// do the people who turned HTML off.

export interface EmailContent {
  subject: string
  html: string
  text: string
}

export interface EmailLayoutOptions {
  heading: string
  /** Body paragraphs, plain sentences — no markup. */
  paragraphs: string[]
  action?: { label: string; url: string }
  /** Small print under the rule (e.g. "you're getting this because…"). */
  footnote?: string
}

/**
 * Escape for interpolation into HTML — user names come from OAuth providers.
 *
 * Exported as `escapeEmailHtml` rather than `escapeHtml`: Nitro auto-imports
 * every name in server/utils into one namespace, and a bare `escapeHtml` there
 * is the kind of name a second module will eventually also want.
 */
export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The one email chrome this app has: centered table, inline styles, hex colors,
 * no web fonts, no external images. Exported because there were three
 * hand-copied versions of this scaffold — here, in account-email.ts, and in
 * auth-email-templates.ts — and three copies of a palette is three things to
 * miss on the first rebrand. See the file header for why it looks like 2004.
 */
export function emailLayout(
  appName: string,
  appUrl: string,
  opts: EmailLayoutOptions,
): { html: string; text: string } {
  const button = opts.action
    ? `<tr><td style="padding:8px 0 24px 0;">
         <a href="${opts.action.url}" style="display:inline-block;background:#c74f2f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:500;">${escapeEmailHtml(opts.action.label)}</a>
       </td></tr>`
    : ''

  const paragraphs = opts.paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 0 16px 0;font-size:16px;line-height:1.65;color:#292524;">${escapeEmailHtml(p)}</td></tr>`,
    )
    .join('')

  const footnote = opts.footnote
    ? `<tr><td style="padding:24px 0 0 0;border-top:1px solid #e7e5e4;font-size:13px;line-height:1.5;color:#78716c;">${escapeEmailHtml(opts.footnote)}</td></tr>`
    : ''

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeEmailHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#fafaf9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e5e4;border-radius:4px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 8px 0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#78716c;">${escapeEmailHtml(appName)}</td></tr>
    <tr><td style="padding:0 0 20px 0;font-size:24px;line-height:1.3;color:#1c1917;">${escapeEmailHtml(opts.heading)}</td></tr>
    ${paragraphs}
    ${button}
    ${footnote}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:16px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="font-size:12px;color:#a8a29e;"><a href="${appUrl}" style="color:#a8a29e;">${escapeEmailHtml(appName)}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`

  const text = [
    opts.heading,
    '',
    ...opts.paragraphs,
    ...(opts.action ? ['', `${opts.action.label}: ${opts.action.url}`] : []),
    ...(opts.footnote ? ['', '—', opts.footnote] : []),
    '',
    appUrl,
  ].join('\n')

  return { html, text }
}

export interface Branding {
  appName: string
  appUrl: string
}

/** First sign-in. Short on purpose — nobody reads a welcome tour. */
export function welcomeEmail(brand: Branding, opts: { name: string }): EmailContent {
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: `Welcome to ${brand.appName}`,
    paragraphs: [
      `Hi ${opts.name} — your account is ready.`,
      `You're signed in already. If you ever get locked out, sign in again with the same provider and you'll land back on this account.`,
    ],
    action: { label: 'Open the app', url: brand.appUrl },
    footnote: `You're receiving this because an account was created with this email address at ${brand.appName}.`,
  })
  return { subject: `Welcome to ${brand.appName}`, ...body }
}

/** Money changed hands. Paddle sends the tax receipt; this confirms access. */
export function purchaseEmail(
  brand: Branding,
  opts: { name: string; kind: 'subscription' | 'pass'; endsAt: Date | null },
): EmailContent {
  const isPassPurchase = opts.kind === 'pass'
  const ends = opts.endsAt
    ? opts.endsAt.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
    : null

  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: isPassPurchase ? 'Your pass is active' : 'Your subscription is active',
    paragraphs: [
      `Thanks, ${opts.name}. Your access is live — nothing else to do.`,
      isPassPurchase
        ? `This is a one-time pass${ends ? `, good through ${ends}` : ''}. It won't renew, and you won't be charged again.`
        : `Your subscription renews automatically${ends ? `, next on ${ends}` : ''}. You can cancel any time from your account page — no email required.`,
      `Paddle handles the payment, so your receipt and invoice come from them in a separate email.`,
    ],
    action: { label: 'Go to your account', url: `${brand.appUrl}/account` },
    footnote: `Questions about the charge? Reply to this email.`,
  })
  return {
    subject: isPassPurchase
      ? `Your ${brand.appName} pass is active`
      : `Your ${brand.appName} subscription is active`,
    ...body,
  }
}

/** A card failed. The only email here with real urgency, so it says the deadline. */
export function paymentFailedEmail(brand: Branding, opts: { name: string }): EmailContent {
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: 'Your payment did not go through',
    paragraphs: [
      `Hi ${opts.name} — the last charge for your ${brand.appName} subscription was declined.`,
      `Paddle will retry it over the next few days. If it keeps failing, your access will stop. Updating your card now avoids that entirely.`,
    ],
    action: { label: 'Update payment method', url: `${brand.appUrl}/account` },
    footnote: `If you meant to cancel, you can ignore this — access ends on its own.`,
  })
  return { subject: `Action needed: payment failed for ${brand.appName}`, ...body }
}

/** Access ended — cancellation, refund, or chargeback. Never argumentative. */
export function accessEndedEmail(
  brand: Branding,
  opts: { name: string; reason: 'canceled' | 'refunded' | 'chargeback' | 'comp_revoked' },
): EmailContent {
  const reasonLine = {
    canceled: `Your subscription has been canceled and your access has ended.`,
    refunded: `Your payment was refunded, so the access it paid for has ended.`,
    chargeback: `A chargeback was filed on this payment, so access has been suspended while it's resolved.`,
    // No money was involved, so this says nothing about a payment. It also does
    // not say "an admin removed it" — the customer did nothing wrong, the grant
    // was ours to give and ours to correct, and an accusatory sentence about
    // free access is the worst possible trade of goodwill for precision.
    comp_revoked: `The complimentary access on your account has ended.`,
  }[opts.reason]

  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: 'Your access has ended',
    paragraphs: [
      `Hi ${opts.name} — ${reasonLine}`,
      `Your account and data are still here. Subscribing again turns everything back on where you left it.`,
    ],
    action: { label: 'See plans', url: `${brand.appUrl}/pricing` },
    footnote:
      opts.reason === 'chargeback'
        ? `If you didn't file this chargeback, reply to this email and we'll sort it out.`
        : `If this was a mistake, reply to this email and we'll help.`,
  })
  return { subject: `Your ${brand.appName} access has ended`, ...body }
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
 * safe here only because layout() escapes every paragraph it renders — pass it
 * anywhere that doesn't, and you have built an HTML-injection vector into your
 * own outbound mail.
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

  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: 'Re: your feedback',
    paragraphs: [opts.reply, '—', `You wrote: "${quoted}"`],
    footnote: `You're receiving this because you sent feedback through ${brand.appName}. Replying to this email reaches a person.`,
  })
  return { subject: `Re: your feedback on ${brand.appName}`, ...body }
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
