// The account-deletion confirmation email.
//
// In its own file because it belongs to the account lifecycle rather than to
// billing or auth — but it renders through the SAME chrome as every other email
// this app sends, `emailLayout()` from server/utils/email-templates.ts. It used
// to hand-copy that scaffold, which meant three literal copies of the palette
// across three template files and a rebrand that would silently have missed two
// of them. The reason for the copy (another wave was editing that file at the
// time) has expired; the copy should not outlive it.

import { emailLayout, type Branding, type EmailContent } from './email-templates'

/**
 * Sent by the caller (DELETE /api/account) BEFORE the `users` row is
 * anonymized — it's the last message that can reach the real address, because
 * server/utils/account.ts rewrites it to a synthetic tombstone the moment
 * deletion succeeds. Confirms exactly what /privacy promises: the account and
 * its contents are gone, and billing records are the one thing kept, for tax
 * law.
 *
 * No `action` button on purpose. Every other email here ends in something to
 * click; this one has nowhere to send someone — the account it is about no
 * longer exists — and a "Go to your account" button under a deletion notice
 * would be a broken promise in the most alarming possible place.
 */
export function accountDeletedEmail(brand: Branding, opts: { name: string }): EmailContent {
  const heading = 'Your account has been deleted'
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading,
    paragraphs: [
      `Hi ${opts.name} — this confirms your ${brand.appName} account and everything in it has been deleted, as you asked.`,
      `Billing records are kept for as long as tax law requires — that's the only thing this doesn't touch, and it's described in our privacy policy.`,
      `If you didn't request this, reply to this email right away.`,
    ],
  })
  return { subject: heading, ...body }
}
