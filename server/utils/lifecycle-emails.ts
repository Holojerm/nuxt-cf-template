// Copy for lifecycle steps that have a template of their own. The steps defined
// as data (server/utils/lifecycle-sequence.ts) carry their wording there.
//
// One rule for all of them: a lifecycle email is unasked-for, so it earns its
// place by being short and useful to the reader, never by urgency. No countdown
// language, no "last chance", no discount to stay — the product rules forbid
// dark patterns and these are where they usually start.

import { composeEmail, type Branding, type EmailContent } from './email-templates'

/**
 * A pass is about to run out and nothing will renew it. Mandatory mail: with
 * auto-renew off by default, this is the only thing that tells someone their
 * access is about to stop, so it is an account notice rather than marketing.
 */
export function passExpiringEmail(
  brand: Branding,
  opts: { name: string; endsAt: Date },
): EmailContent {
  const date = opts.endsAt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return composeEmail('pass-expiring', `Your ${brand.appName} access ends ${date}`, brand, {
    name: opts.name,
    date,
  })
}
