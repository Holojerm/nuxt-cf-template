// The sign-in emails. Same contract as server/utils/email-templates.ts — plain
// functions returning { subject, html, text } — kept in their own file because
// they are the one class of mail that is *load-bearing*: a welcome email that
// bounces is a missed hello, a sign-in link that bounces is a locked door.
//
// It renders through the shared `emailLayout()` rather than a copy of it. The
// copy was justified while another wave held that file open; it is not
// justified by anything now, and three literal copies of the palette is three
// places a rebrand goes wrong. See email-templates.ts for why the markup looks
// like 2004, and note that DESIGN.md's token layer does not reach here — there
// is no CSS cascade in an email to hang tokens on, and design:check only scans
// app/.
//
// ── What stays deliberate about this one ─────────────────────────────────────
// A sign-in link is the message most likely to be filtered (transactional,
// urgent wording, one prominent link — the exact shape of a phishing mail), and
// the two things that most reliably help are a short body and a real
// plain-text alternative. So it carries one paragraph, one button, and the URL
// spelled out for the gateways that rewrite anchors. It also carries no name:
// this email is sent before we know whether the address has an account at all,
// and greeting a stranger by a guessed name would be both wrong and a hint
// about who is registered.

import { emailLayout, type Branding, type EmailContent } from './email-templates'

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
 */
export function magicLinkEmail(brand: Branding, opts: MagicLinkEmailOptions): EmailContent {
  const heading = `Sign in to ${brand.appName}`
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading,
    paragraphs: [
      `This link works once and expires in ${opts.expiresMinutes} minutes.`,
      // The URL in full, because a gateway that rewrites the button's href
      // still leaves this readable, and a plain-text client shows only this.
      `Or paste this into your browser: ${opts.url}`,
    ],
    action: { label: 'Sign in', url: opts.url },
    footnote: `If you didn't ask to sign in, you can ignore this email — nothing happens until the link is opened, and no account is created by this message.`,
  })
  return { subject: heading, ...body }
}
