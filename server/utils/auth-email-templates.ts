// The sign-in emails. Same contract as server/utils/email-templates.ts — plain
// functions returning { subject, html, text } — kept in their own file because
// they are the one class of mail that is *load-bearing*: a welcome email that
// bounces is a missed hello, a sign-in link that bounces is a locked door.
//
// ── Why the markup is smaller than the rest of the app's mail ────────────────
// Deliberate, not lazy. A sign-in link is the message most likely to be filtered
// (transactional, urgent wording, a single prominent link — the exact shape of a
// phishing mail), and the two things that most reliably help are a short body
// with a high text-to-markup ratio and a real plain-text alternative. So this
// keeps the app's mail styling — one centered table, inline styles, hex colors,
// no web fonts, no external images, because email clients are not browsers — and
// nothing else. See email-templates.ts for the full explanation of that style;
// this file duplicates its private `layout()` in miniature rather than exporting
// it, and folding the two together is a fine cleanup for whoever next touches
// both files.
//
// DESIGN.md's token layer does not reach here — there is no CSS cascade in an
// email to hang tokens on, and design:check only scans app/.

/**
 * What this email is, in the taxonomy of shared/utils/notifications.ts.
 *
 * ── Why it is named, given nothing reads it today ────────────────────────────
 * `sendEmail()` takes `unsubscribe` as an option and the magic-link send simply
 * doesn't pass one, so no List-Unsubscribe header is attached. But "correct
 * because a caller omitted an argument" is a property that survives exactly
 * until the next refactor. Naming the class makes it structural instead: the
 * `security.` prefix means isMandatoryNotification() returns true for it, so
 * every existing enforcement point already refuses to make this unsubscribable
 * — isNotificationEnabled() short-circuits to true without reading the
 * preferences table, and buildResendEmailRequest() strips the header even if a
 * caller passes one by mistake. Wiring this email through either of them later
 * is then a no-op rather than a regression.
 *
 * It is also the one email in the app that could not be opt-out-able even if
 * someone wanted it to be: it is sent before we know whether the address has an
 * account at all, so there is no user id to look a preference up by and none to
 * build an unsubscribe URL from. An inbox that can suppress its own sign-in
 * links is an inbox that has locked itself out.
 */
export const MAGIC_LINK_EVENT_TYPE = 'security.sign_in_link'

/** Escape for interpolation into HTML. The app name comes from runtime config. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Branding {
  appName: string
  appUrl: string
}

export interface MagicLinkEmailOptions {
  /** Absolute URL of the confirmation page, token included. */
  url: string
  /** Minutes until the link stops working — said out loud, so it isn't a surprise. */
  expiresMinutes: number
}

/**
 * The sign-in link itself.
 *
 * Three things this copy has to do, in order of how often they are got wrong:
 *
 *   1. Say the expiry. "This link didn't work" is nearly always "this link is
 *      forty minutes old", and a reader who knows the window retries instead of
 *      emailing support.
 *   2. Give the URL as text as well as a button. Corporate mail gateways rewrite
 *      or strip anchors, and plain-text readers get nothing from a <a>.
 *   3. Tell someone who did NOT request it that ignoring the mail is enough. It
 *      is: no account is created and nothing changes until the link is opened.
 *      That sentence is what turns a stray link into a non-event rather than a
 *      support ticket.
 *
 * There is no name in here on purpose. This email is sent before we know whether
 * the address has an account at all — greeting a stranger by a name we guessed
 * would be both wrong and a hint about who is registered.
 */
export function magicLinkEmail(
  brand: Branding,
  opts: MagicLinkEmailOptions,
): { subject: string; html: string; text: string } {
  const heading = `Sign in to ${brand.appName}`
  const expiry = `This link works once and expires in ${opts.expiresMinutes} minutes.`
  const ignore = `If you didn't ask to sign in, you can ignore this email — nothing happens until the link is opened, and no account is created by this message.`

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#fafaf9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e5e4;border-radius:4px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 8px 0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#78716c;">${escapeHtml(brand.appName)}</td></tr>
    <tr><td style="padding:0 0 20px 0;font-size:24px;line-height:1.3;color:#1c1917;">${escapeHtml(heading)}</td></tr>
    <tr><td style="padding:0 0 16px 0;font-size:16px;line-height:1.65;color:#292524;">${escapeHtml(expiry)}</td></tr>
    <tr><td style="padding:8px 0 24px 0;">
      <a href="${opts.url}" style="display:inline-block;background:#c74f2f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:500;">Sign in</a>
    </td></tr>
    <tr><td style="padding:0 0 16px 0;font-size:14px;line-height:1.6;color:#78716c;word-break:break-all;">Or paste this into your browser:<br>${escapeHtml(opts.url)}</td></tr>
    <tr><td style="padding:24px 0 0 0;border-top:1px solid #e7e5e4;font-size:13px;line-height:1.5;color:#78716c;">${escapeHtml(ignore)}</td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:16px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <tr><td style="font-size:12px;color:#a8a29e;"><a href="${brand.appUrl}" style="color:#a8a29e;">${escapeHtml(brand.appName)}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`

  const text = [heading, '', expiry, '', opts.url, '', '—', ignore, '', brand.appUrl].join('\n')

  return { subject: heading, html, text }
}
