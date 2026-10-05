// Sample data for every email — what `bun run email:dev` and `bun run
// email:preview` fill the templates with, and what test/emails.test.ts renders
// to prove every template compiles, fills in and escapes. One entry per file in
// emails/templates/; the test fails when the two lists disagree.
//
// Plain data, no imports: it runs in Bun (the dev server) and in workerd (the
// test suite), which share nothing else.

export type EmailSample = Record<string, unknown>

const brand = { appName: 'My App', appUrl: 'https://my-app.example' }
const rows = (kind: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: `Oct 4, 20:0${i} UTC`,
    path: `/api/${kind}/${i}`,
    pathUrl: `${brand.appUrl}/api/${kind}/${i}`,
    detail: i === 0 ? 'D1_ERROR: no such table: widgets' : null,
  }))

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
  'ops-digest': {
    ...brand,
    summary: '9 new events since Oct 4, 20:00 UTC',
    generated: 'Oct 4, 21:30 UTC',
    logsUrl:
      'https://dash.cloudflare.com/?to=/:account/workers/services/view/my-app/production/observability',
    kinds: [
      {
        kind: 'server_error',
        label: 'Server error',
        count: 7,
        bad: true,
        rows: rows('server_error', 5),
        more: 2,
      },
      {
        kind: 'paddle_webhook_rejected',
        label: 'Paddle webhook rejected',
        count: 1,
        warn: true,
        rows: [{ time: 'Oct 4, 20:05 UTC', path: null, pathUrl: null, detail: 'bad signature' }],
        more: 0,
      },
      {
        kind: 'cron_recovered',
        label: 'Cron recovered',
        count: 1,
        good: true,
        rows: [
          {
            time: 'Oct 4, 20:09 UTC',
            path: '/_nitro/tasks/ops/alert',
            pathUrl: null,
            detail: null,
          },
        ],
        more: 0,
      },
    ],
  },
  'pass-expiring': { ...brand, name: 'Ada', date: 'October 7' },
  'payment-failed': { ...brand, name: 'Ada' },
  purchase: { ...brand, name: 'Ada', isPass: false, ends: 'November 4, 2026' },
  welcome: { ...brand, name: 'Ada' },
}
