// How an ops digest reads — the subject, the HTML and the plain-text body.
// Pure string-building, kept apart from server/utils/ops.ts so the drain logic
// there stays about rows and retries, and this stays about wording.
//
// The HTML follows email-templates.ts's rules (one table, inline styles, hex
// colors, nothing external) for the same reason: Gmail and Outlook are not
// browsers. It is a separate scaffold rather than `emailLayout()` because a
// digest is a list of grouped rows, not paragraphs and a button. It also
// imports nothing from the email stack, so forks that tore out transactional
// email (TEARDOWN.md) keep their alerts.

function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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

const TONE_COLOR: Record<Tone, string> = { bad: '#b91c1c', warn: '#b45309', good: '#15803d' }

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

export function renderOpsDigestText(
  kinds: [string, OpsDigestRow[]][],
  total: number,
  oldest: Date,
  opts: OpsDigestRenderOptions,
): string {
  const lines = [`${summary(total, oldest)}.`, '']
  for (const [kind, rows] of kinds) {
    lines.push(`${opsKindLabel(kind)} (${kind}) ×${rows.length}`)
    for (const row of rows.slice(0, OPS_DIGEST_ROWS_PER_KIND)) {
      const where = row.path ? `  ${row.path}` : ''
      lines.push(`  • ${formatOpsTime(row.createdAt)}${where}`)
      if (row.detail) lines.push(`    ${row.detail}`)
    }
    if (rows.length > OPS_DIGEST_ROWS_PER_KIND) {
      lines.push(`  …and ${rows.length - OPS_DIGEST_ROWS_PER_KIND} more`)
    }
    lines.push('')
  }
  if (opts.workerName) lines.push(`Logs: ${opsLogsUrl(opts.workerName)}`)
  lines.push('Runbook: README.md › Ops alerting', `Generated ${formatOpsTime(opts.now)}`)
  return lines.join('\n')
}

function rowHtml(row: OpsDigestRow, appUrl: string | undefined): string {
  const path = row.path ? escapeEmailHtml(row.path) : ''
  const where = !path
    ? ''
    : appUrl && row.path!.startsWith('/')
      ? ` &middot; <a href="${escapeEmailHtml(appUrl + row.path)}" style="color:#57534e;">${path}</a>`
      : ` &middot; ${path}`
  const detail = row.detail
    ? `<div style="font-size:14px;line-height:1.5;color:#292524;word-break:break-word;">${escapeEmailHtml(row.detail)}</div>`
    : ''
  return `<tr><td style="padding:8px 0;border-top:1px solid #f5f5f4;">
<div style="font-size:12px;color:#78716c;font-family:ui-monospace,Menlo,Consolas,monospace;">${formatOpsTime(row.createdAt)}${where}</div>${detail}
</td></tr>`
}

function kindHtml(kind: string, rows: OpsDigestRow[], appUrl: string | undefined): string {
  const color = TONE_COLOR[toneOf(kind)]
  const shown = rows
    .slice(0, OPS_DIGEST_ROWS_PER_KIND)
    .map((r) => rowHtml(r, appUrl))
    .join('')
  const more =
    rows.length > OPS_DIGEST_ROWS_PER_KIND
      ? `<tr><td style="padding:8px 0 0 0;font-size:13px;color:#78716c;">…and ${rows.length - OPS_DIGEST_ROWS_PER_KIND} more</td></tr>`
      : ''
  return `<tr><td style="padding:0 0 20px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${color};padding-left:12px;">
<tr><td style="padding:0 0 4px 0;font-size:15px;font-weight:600;color:#1c1917;">${escapeEmailHtml(opsKindLabel(kind))}
<span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:${color};color:#ffffff;font-size:12px;font-weight:600;">${rows.length}</span>
<span style="margin-left:6px;font-size:12px;font-weight:400;color:#a8a29e;font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeEmailHtml(kind)}</span></td></tr>
${shown}${more}
</table></td></tr>`
}

function button(label: string, url: string): string {
  return `<a href="${escapeEmailHtml(url)}" style="display:inline-block;margin:0 8px 8px 0;background:#1c1917;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:4px;font-size:14px;font-weight:500;">${escapeEmailHtml(label)}</a>`
}

export function renderOpsDigestHtml(
  kinds: [string, OpsDigestRow[]][],
  total: number,
  oldest: Date,
  opts: OpsDigestRenderOptions,
): string {
  const actions = [
    opts.workerName ? button('Open logs', opsLogsUrl(opts.workerName)) : '',
    opts.appUrl ? button(`Open ${opts.appName}`, opts.appUrl) : '',
  ].join('')
  const title = escapeEmailHtml(`${opts.appName} alert`)
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#fafaf9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:0 0 4px 0;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#78716c;">${title}</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:20px;font-weight:600;line-height:1.3;color:#1c1917;">${escapeEmailHtml(summary(total, oldest))}</td></tr>
${kinds.map(([kind, rows]) => kindHtml(kind, rows, opts.appUrl)).join('')}
${actions ? `<tr><td style="padding:4px 0 8px 0;">${actions}</td></tr>` : ''}
<tr><td style="padding:16px 0 0 0;border-top:1px solid #e7e5e4;font-size:12px;line-height:1.5;color:#78716c;">Runbook: README.md › Ops alerting. Sent by the ops:alert cron when events are waiting; quiet ticks send nothing. Generated ${formatOpsTime(opts.now)}.</td></tr>
</table>
</td></tr></table>
</body></html>`
}
