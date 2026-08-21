// The changelog, as data. Rendered by app/pages/changelog.vue.
//
// ── Why this page exists ─────────────────────────────────────────────────────
// It closes the only loop the app was missing. Feedback came in, issues got
// filed, fixes shipped — and the person who reported the thing never found out.
// A public changelog is the cheapest way to tell everyone at once, and the
// reply endpoint (POST /api/feedback/[id]/reply) is how you tell one person.
//
// It also gives the SEO/AEO machinery something to eat. sitemap.xml and
// llms.txt are built from `publicPage` declarations, and until now there were
// six evergreen pages to index. A changelog is the one page on a SaaS site
// that legitimately changes every week.
//
// Newest first. Keep entries short — this is a list of things that changed, not
// release notes, and nobody reads the second paragraph.

export type ChangeKind = 'added' | 'improved' | 'fixed'

export interface ChangelogEntry {
  /** ISO date, `YYYY-MM-DD`. Rendered as the entry's heading. */
  date: string
  /** Optional version or release name, shown as a badge when present. */
  version?: string
  changes: { kind: ChangeKind; text: string }[]
}

/** Badge colour per kind. Semantic tokens only — no raw palette values. */
export const CHANGE_KIND_COLOR: Record<ChangeKind, 'success' | 'info' | 'warning'> = {
  added: 'success',
  improved: 'info',
  fixed: 'warning',
}

/**
 * Replace every entry below with your own — these describe the template, not
 * your product, and shipping them unedited tells your visitors exactly which
 * boilerplate you started from.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-08-21',
    version: 'v0.4',
    changes: [
      { kind: 'added', text: 'Checkout funnel tracking, so abandonment is measurable.' },
      { kind: 'added', text: 'Feature flags via useFlag(), for shipping behind a toggle.' },
      { kind: 'added', text: 'A cancellation prompt that asks why, without getting in the way.' },
      { kind: 'added', text: 'First-touch attribution stored on the account itself.' },
      { kind: 'added', text: 'This page.' },
    ],
  },
  {
    date: '2026-08-14',
    version: 'v0.3',
    changes: [
      { kind: 'added', text: 'Accessibility and mobile guardrails, enforced in CI.' },
      { kind: 'added', text: 'Canonical URLs, structured data, and llms.txt.' },
      { kind: 'improved', text: 'Billing emails now fire on status transitions, not every event.' },
    ],
  },
  {
    date: '2026-08-07',
    version: 'v0.2',
    changes: [
      { kind: 'added', text: 'GitHub and Google sign-in, wired end to end.' },
      {
        kind: 'added',
        text: 'Paddle billing: checkout, entitlements, and self-serve cancellation.',
      },
      { kind: 'fixed', text: 'Refunds and chargebacks now revoke access immediately.' },
    ],
  },
]

/** `2026-08-21` → `21 August 2026`. Fixed locale so SSR and client agree. */
export function formatChangelogDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
