// Sample data for every email — what `bun run email:dev` and `bun run
// email:preview` fill the templates with, and what test/emails.test.ts renders
// to prove every template compiles, fills in and escapes. One entry per file in
// emails/templates/; the test fails when the two lists disagree.
//
// Plain data, no imports: it runs in Bun (the dev server) and in workerd (the
// test suite), which share nothing else.

export type EmailSample = Record<string, unknown>

const brand = { appName: 'My App', appUrl: 'https://my-app.example' }

export const SAMPLES: Record<string, EmailSample> = {
  'access-ended': { ...brand, name: 'Ada', canceled: true },
  'account-deleted': { ...brand, name: 'Ada' },
  'activation-nudge': { ...brand, name: 'Ada' },
  'feedback-reply': {
    ...brand,
    reply: 'Fixed in this morning’s release — thanks for the report.',
    quoted: 'The export button does nothing on Safari',
  },
  'magic-link': {
    ...brand,
    url: `${brand.appUrl}/auth/confirm?token=2f9c1d`,
    expiresMinutes: 15,
  },
  'pass-expiring': { ...brand, name: 'Ada', date: 'October 7' },
  'payment-failed': { ...brand, name: 'Ada' },
  purchase: { ...brand, name: 'Ada', isPass: false, ends: 'November 4, 2026' },
  welcome: { ...brand, name: 'Ada' },
}
