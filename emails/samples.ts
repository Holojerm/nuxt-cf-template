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
  note: {
    ...brand,
    heading: 'Exports are here',
    paragraphs: [
      'You can now export everything in your account as a single file.',
      'It is on your account page, under Your data.',
    ],
    button: { label: 'See what changed', url: `${brand.appUrl}/changelog` },
    footnote: 'You’re receiving this because you have an account at My App.',
  },
  'pass-expiring': { ...brand, name: 'Ada', date: 'October 7' },
  'password-reset': {
    ...brand,
    url: `${brand.appUrl}/auth/reset#token=8a1b3c`,
    expiresMinutes: 30,
  },
  'payment-failed': { ...brand, name: 'Ada' },
  purchase: { ...brand, name: 'Ada', isPass: false, ends: 'November 4, 2026' },
  'subscribe-confirm': {
    ...brand,
    url: `${brand.appUrl}/updates/confirm#t=9e2f`,
    days: 7,
  },
  'verify-email': {
    ...brand,
    url: `${brand.appUrl}/auth/verify-email#token=5d7e9f`,
    expiresMinutes: 60,
  },
}
