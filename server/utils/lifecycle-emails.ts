// Copy for the template's lifecycle steps (server/utils/lifecycle-steps.ts).
//
// Same rules as email-templates.ts, plus one: a lifecycle email is unasked-for,
// so it earns its place by being short and useful to the reader, never by
// urgency. No countdown language, no "last chance", no discount to stay — the
// product rules forbid dark patterns and these are where they usually start.

import { emailLayout, type Branding, type EmailContent } from './email-templates'

/** Signed up, never finished setting up. Sent once, a day or more after signup. */
export function activationNudgeEmail(brand: Branding, opts: { name: string }): EmailContent {
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: 'Pick up where you left off',
    paragraphs: [
      `Hi ${opts.name} — you created a ${brand.appName} account but haven't finished getting set up.`,
      `It takes a couple of minutes, and the checklist on your dashboard shows exactly what's left.`,
      `If something got in the way, reply to this email — a person reads it.`,
    ],
    action: { label: 'Finish setting up', url: `${brand.appUrl}/dashboard` },
    footnote: `This is the only reminder we send about setup.`,
  })
  return { subject: `Finish setting up ${brand.appName}`, ...body }
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
  const body = emailLayout(brand.appName, brand.appUrl, {
    heading: `Your access runs until ${date}`,
    paragraphs: [
      `Hi ${opts.name} — your ${brand.appName} pass ends on ${date}. It won't renew, and you won't be charged.`,
      `If you want to keep going, you can buy another pass or turn on monthly renewal from your account. If not, there's nothing to do — your account and work stay here either way.`,
    ],
    action: { label: 'Manage access', url: `${brand.appUrl}/account` },
    footnote: `You're receiving this because your pass is ending. It's sent once per pass.`,
  })
  return { subject: `Your ${brand.appName} access ends ${date}`, ...body }
}
