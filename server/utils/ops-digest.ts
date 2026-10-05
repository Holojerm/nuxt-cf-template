// How an ops digest reads — the subject, and the data its email is filled with.
// Kept apart from server/utils/ops.ts so the drain logic there stays about rows
// and retries, and this stays about wording and grouping.
//
// The markup is emails/templates/ops-digest.vue and its .txt sibling, compiled
// by Maizzle like every other email and filled in by renderEmail().
//
// The one import from the email stack is the renderer, on purpose: forks that
// tore out transactional email (TEARDOWN.md) keep their alerts, so nothing here
// may reach for email-templates.ts or the transactional templates. Deleting
// those templates is safe; deleting render-email.ts, emails/components/ or
// emails/templates/ops-digest.* is not.

import { renderEmail, type RenderedEmail } from './render-email'

export interface OpsDigestRow {
  kind: string
  detail: string | null
  path: string | null
  createdAt: Date
}

export interface OpsDigestRenderOptions {
  appName: string
  /** Absolute origin; when set, each row's path becomes a link. */
  appUrl?: string
  workerName?: string
  now: Date
}

/** Rows shown per kind. Enough to tell "one broken route" from "everything". */
export const OPS_DIGEST_ROWS_PER_KIND = 5

/** `paddle_webhook_rejected` → `Paddle webhook rejected`. Kinds are snake_case log ids. */
export function opsKindLabel(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

type Tone = 'bad' | 'good' | 'warn'

function toneOf(kind: string): Tone {
  if (/resolved|recovered|ok$/.test(kind)) return 'good'
  if (/error|fail|reject|invalid|unparseable|down/.test(kind)) return 'bad'
  return 'warn'
}

/** `Oct 4, 20:01 UTC` — a digest is read hours later, so absolute and zoned. */
export function formatOpsTime(d: Date): string {
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const time = d.toISOString().slice(11, 16)
  return `${date}, ${time} UTC`
}

export function opsLogsUrl(workerName: string): string {
  return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${workerName}/production/observability`
}

/** Loudest kind first — that's the headline. */
export function groupOpsRows<T extends OpsDigestRow>(rows: T[]): [string, T[]][] {
  const byKind = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = byKind.get(row.kind)
    if (bucket) bucket.push(row)
    else byKind.set(row.kind, [row])
  }
  return [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)
}

export function opsDigestSubject(appName: string, kinds: [string, OpsDigestRow[]][]): string {
  const [topKind, topRows] = kinds[0]!
  const rest = kinds.slice(1).reduce((n, [, r]) => n + r.length, 0)
  const head = `${appName} alert · ${opsKindLabel(topKind)} ×${topRows.length}`
  return rest ? `${head} + ${rest} more` : head
}

function summary(total: number, oldest: Date): string {
  return `${total} new event${total === 1 ? '' : 's'} since ${formatOpsTime(oldest)}`
}

/** A row's path is only a link when the app's origin is known and the path is its own. */
function rowData(row: OpsDigestRow, appUrl: string | undefined) {
  return {
    time: formatOpsTime(row.createdAt),
    path: row.path,
    pathUrl: appUrl && row.path?.startsWith('/') ? appUrl + row.path : null,
    detail: row.detail,
  }
}

/** The HTML and the plain text, from one set of data. */
export function renderOpsDigest(
  kinds: [string, OpsDigestRow[]][],
  total: number,
  oldest: Date,
  opts: OpsDigestRenderOptions,
): RenderedEmail {
  return renderEmail('ops-digest', {
    appName: opts.appName,
    appUrl: opts.appUrl,
    summary: summary(total, oldest),
    generated: formatOpsTime(opts.now),
    logsUrl: opts.workerName ? opsLogsUrl(opts.workerName) : null,
    kinds: kinds.map(([kind, rows]) => ({
      kind,
      label: opsKindLabel(kind),
      count: rows.length,
      // One flag per tone: the template picks a color with {{#bad}}, because the
      // colors are fixed at build time and the kind only exists at runtime.
      [toneOf(kind)]: true,
      rows: rows.slice(0, OPS_DIGEST_ROWS_PER_KIND).map((row) => rowData(row, opts.appUrl)),
      more: Math.max(0, rows.length - OPS_DIGEST_ROWS_PER_KIND),
    })),
  })
}
