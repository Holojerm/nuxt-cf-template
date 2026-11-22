// The two emails behind the product-updates programme: the `note`, whose copy is
// data (a lifecycle step or an announcement), and the double opt-in confirmation.
// Wording for the second is emails/templates/subscribe-confirm.vue.

import { composeEmail, type Branding, type EmailContent } from './email-templates'

export interface NoteContent {
  subject: string
  heading: string
  paragraphs: readonly string[]
  /** `url` is absolute. */
  button?: { label: string; url: string }
  /** Why the reader got this email. */
  footnote: string
}

/**
 * The email whose copy is data: a lifecycle step or an announcement. Every field
 * reaches the template as a {{double}} tag, so none of it can carry markup.
 */
export function noteEmail(brand: Branding, note: NoteContent): EmailContent {
  return composeEmail('note', note.subject, brand, {
    heading: note.heading,
    paragraphs: note.paragraphs,
    button: note.button ?? null,
    footnote: note.footnote,
  })
}

/**
 * Double opt-in for a visitor with no account (server/utils/subscribers.ts).
 * The only email an unconfirmed address is ever sent.
 */
export function subscribeConfirmEmail(
  brand: Branding,
  opts: { url: string; days: number },
): EmailContent {
  return composeEmail(
    'subscribe-confirm',
    `Confirm your email for ${brand.appName} updates`,
    brand,
    {
      url: opts.url,
      days: opts.days,
    },
  )
}
