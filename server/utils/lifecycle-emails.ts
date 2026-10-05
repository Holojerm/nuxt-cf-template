// Copy for the template's lifecycle steps (server/utils/lifecycle-steps.ts).
//
// The wording is emails/templates/activation-nudge.vue and pass-expiring.vue
// (plus their .txt siblings); see server/utils/email-templates.ts for how that
// reaches here. One rule on top of those: a lifecycle email is unasked-for,
// so it earns its place by being short and useful to the reader, never by
// urgency. No countdown language, no "last chance", no discount to stay — the
// product rules forbid dark patterns and these are where they usually start.

import { composeEmail, type Branding, type EmailContent } from './email-templates'

/** Signed up, never finished setting up. Sent once, a day or more after signup. */
export function activationNudgeEmail(brand: Branding, opts: { name: string }): EmailContent {
  return composeEmail('activation-nudge', `Finish setting up ${brand.appName}`, brand, {
    name: opts.name,
  })
}

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
