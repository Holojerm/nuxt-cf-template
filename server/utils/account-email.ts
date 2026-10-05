// The account-deletion confirmation email.
//
// In its own file because it belongs to the account lifecycle rather than to
// billing or auth. The wording is emails/templates/account-deleted.vue and
// its .txt sibling, compiled like every other email — see
// server/utils/email-templates.ts.

import { composeEmail, type Branding, type EmailContent } from './email-templates'

/**
 * Sent by the caller (DELETE /api/account) BEFORE the `users` row is
 * anonymized — it's the last message that can reach the real address, because
 * server/utils/account.ts rewrites it to a synthetic tombstone the moment
 * deletion succeeds. Confirms exactly what /privacy promises: the account and
 * its contents are gone, and billing records are the one thing kept, for tax
 * law.
 *
 * No button on purpose. Every other email here ends in something to
 * click; this one has nowhere to send someone — the account it is about no
 * longer exists — and a "Go to your account" button under a deletion notice
 * would be a broken promise in the most alarming possible place.
 */
export function accountDeletedEmail(brand: Branding, opts: { name: string }): EmailContent {
  return composeEmail('account-deleted', 'Your account has been deleted', brand, {
    name: opts.name,
  })
}
