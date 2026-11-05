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

/**
 * How loud a kind is. `critical` means the product has stopped doing its job
 * (data stopped flowing, the site is failing); `warning` is a part degraded;
 * `info` is worth knowing but not worth an email on its own.
 */
export type OpsSeverity = 'critical' | 'warning' | 'info'

export interface OpsKindPolicy {
  severity: OpsSeverity
  /** One line on what to check first. Shown under the kind in the digest. */
  action?: string
}

/**
 * Decides a kind's severity. `count` is how many rows of that kind the digest
 * carries, so a burst can escalate (one 5xx is a warning, a wall of them is not).
 * The template ships none: a fork that passes no classifier gets the unranked
 * digest it always had.
 */
export type OpsClassifier = (kind: string, count: number) => OpsKindPolicy

const SEVERITY_RANK: Record<OpsSeverity, number> = { critical: 0, warning: 1, info: 2 }

const SEVERITY_LABEL: Record<OpsSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

export interface OpsDigestRenderOptions {
  appName: string
  /** Absolute origin; when set, each row's path becomes a link. */
  appUrl?: string
  workerName?: string
  now: Date
  classify?: OpsClassifier
}

/** Rows shown per kind. Enough to tell "one broken route" from "everything". */
export const OPS_DIGEST_ROWS_PER_KIND = 5

/** `paddle_webhook_rejected` → `Paddle webhook rejected`. Kinds are snake_case log ids. */
export function opsKindLabel(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

type Tone = 'bad' | 'good' | 'warn' | 'info'

const SEVERITY_TONE: Record<OpsSeverity, Tone> = { critical: 'bad', warning: 'warn', info: 'info' }

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

/**
 * Most severe first, then loudest — so the headline is what matters, not what
 * repeated most. A wall of source failures must not bury one silent judge.
 * Stable: equal kinds keep groupOpsRows' order.
 */
export function rankOpsKinds<T extends OpsDigestRow>(
  kinds: [string, T[]][],
  classify: OpsClassifier,
): [string, T[]][] {
  const rank = (k: [string, T[]]) => SEVERITY_RANK[classify(k[0], k[1].length).severity]
  return [...kinds].sort((a, b) => rank(a) - rank(b) || b[1].length - a[1].length)
}

/** The highest severity among the kinds, or null when nothing classifies them. */
export function opsDigestSeverity(
  kinds: [string, OpsDigestRow[]][],
  classify: OpsClassifier | undefined,
): OpsSeverity | null {
  if (!classify) return null
  let top: OpsSeverity = 'info'
  for (const [kind, rows] of kinds) {
    const { severity } = classify(kind, rows.length)
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[top]) top = severity
  }
  return top
}

/**
 * `Acme alert · Judge silent ×1 + 3 more`, or with a classifier
 * `[Critical] Acme · Judge silent ×1 + 3 more`. The bracketed tag leads so a
 * mail filter (and a phone's lock screen) can tell the tiers apart. Expects
 * `kinds` already ranked when a classifier is given.
 */
export function opsDigestSubject(
  appName: string,
  kinds: [string, OpsDigestRow[]][],
  classify?: OpsClassifier,
): string {
  const [topKind, topRows] = kinds[0]!
  const rest = kinds.slice(1).reduce((n, [, r]) => n + r.length, 0)
  const severity = opsDigestSeverity(kinds, classify)
  const lead = severity ? `[${SEVERITY_LABEL[severity]}] ${appName}` : `${appName} alert`
  const head = `${lead} · ${opsKindLabel(topKind)} ×${topRows.length}`
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
  const severity = opsDigestSeverity(kinds, opts.classify)
  return renderEmail('ops-digest', {
    appName: opts.appName,
    appUrl: opts.appUrl,
    kicker: severity ? `${opts.appName} · ${SEVERITY_LABEL[severity]}` : `${opts.appName} alert`,
    summary: summary(total, oldest),
    generated: formatOpsTime(opts.now),
    logsUrl: opts.workerName ? opsLogsUrl(opts.workerName) : null,
    kinds: kinds.map(([kind, rows]) => {
      const policy = opts.classify?.(kind, rows.length)
      return {
        kind,
        label: opsKindLabel(kind),
        count: rows.length,
        severity: policy ? SEVERITY_LABEL[policy.severity] : null,
        action: policy?.action ?? null,
        // One flag per tone: the template picks a color with {{#bad}}, because the
        // colors are fixed at build time and the kind only exists at runtime.
        [policy ? SEVERITY_TONE[policy.severity] : toneOf(kind)]: true,
        rows: rows.slice(0, OPS_DIGEST_ROWS_PER_KIND).map((row) => rowData(row, opts.appUrl)),
        more: Math.max(0, rows.length - OPS_DIGEST_ROWS_PER_KIND),
      }
    }),
  })
}
