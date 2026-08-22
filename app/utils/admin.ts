// Presentation helpers for the admin console (app/pages/admin/).
//
// Kept out of the pages because all three of them render the same four kinds of
// thing — a timestamp, an audit action, a feedback status, a feedback kind —
// and a status that means "closed" on one page and "done" on another is a
// support person mis-reading their own queue.
//
// Every status here carries an icon AND a word. DESIGN.md › Accessibility:
// state is never conveyed by color alone, so the color is the third signal
// rather than the only one.

/** NuxtUI's semantic color names — the only palette any of this may reach for. */
type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export interface BadgeMeta {
  label: string
  icon: string
  color: BadgeColor
}

/**
 * Human labels for the audit actions in server/utils/audit.ts.
 *
 * Deliberately phrased as what a person did, not as the wire value: "Granted
 * pass", not "admin.pass_granted". The raw action stays visible in the metadata
 * row underneath, so nothing is hidden — but a trail you have to decode is a
 * trail nobody reads.
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'admin.user_searched': 'Searched for a customer',
  'admin.user_viewed': 'Opened a customer record',
  'admin.user_viewed_as': 'Viewed as customer (read-only)',
  'admin.pass_granted': 'Granted comp access',
  'admin.pass_revoked': 'Revoked comp access',
  'feedback.status_changed': 'Moved feedback through triage',
  'feedback.replied': 'Emailed a customer a reply',
}

/** Falls back to the raw action so a new one is legible before it's mapped. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
}

/**
 * Icons per action. Mutations get a filled, unmistakable mark; reads get a
 * quieter one — skimming the trail should surface "someone changed something"
 * before "someone looked at something".
 */
const AUDIT_ACTION_ICONS: Record<string, string> = {
  // Reads — quieter marks.
  'admin.user_searched': 'i-lucide-search',
  'admin.user_viewed': 'i-lucide-user',
  'admin.user_viewed_as': 'i-lucide-eye',
  // Mutations. Every one of these changed something for a customer, so none of
  // them may fall through to the generic read-tier dot: skimming the trail has
  // to surface "someone did something" before "someone looked at something",
  // and three unmapped actions rendering as raw strings with the same icon as a
  // page view defeated exactly that.
  'admin.pass_granted': 'i-lucide-gift',
  'admin.pass_revoked': 'i-lucide-circle-minus',
  'feedback.status_changed': 'i-lucide-circle-check',
  'feedback.replied': 'i-lucide-send',
}

export function auditActionIcon(action: string): string {
  return AUDIT_ACTION_ICONS[action] ?? 'i-lucide-circle-dot'
}

/**
 * The plan badge, for BOTH /account and the admin console.
 *
 * One function because the two had already drifted: different icons for
 * `trialing` and for the no-plan state, on screens whose entire purpose is that
 * a support person and a customer are looking at the same thing. A support
 * person reading "no access" while the customer reads "no active plan" spends
 * the first minute of the call establishing they are talking about one account.
 *
 * The label is deliberately the customer's wording on both. The console is a
 * mirror of what the customer sees; where it needs operator detail it has the
 * billing table underneath.
 */
const BILLING_STATE_META: Record<string, BadgeMeta> = {
  past_due: { label: 'payment failed', icon: 'i-lucide-credit-card', color: 'warning' },
  trialing: { label: 'trialing', icon: 'i-lucide-clock', color: 'info' },
  active: { label: 'active', icon: 'i-lucide-circle-check', color: 'success' },
  inactive: { label: 'no active plan', icon: 'i-lucide-circle-x', color: 'neutral' },
}

export function billingStateMeta(state: string | null | undefined): BadgeMeta {
  return (state && BILLING_STATE_META[state]) || BILLING_STATE_META.inactive!
}

/**
 * Did this request come back 403?
 *
 * Every admin page asks, and each had its own copy of
 * `error.value?.statusCode === 403` plus its own wording for the answer. Three
 * spellings of one rule is three places to forget it.
 */
export function isForbidden(error: { statusCode?: number } | null | undefined): boolean {
  return error?.statusCode === 403
}

/** The single 403 message. Unified — the three pages had drifted apart. */
export const ADMIN_FORBIDDEN = {
  title: "You don't have access to the admin console",
  description:
    "This area is limited to accounts with the admin role. If you think that's wrong, ask whoever runs this deployment to grant it.",
} as const

const FEEDBACK_STATUS_META: Record<string, BadgeMeta> = {
  new: { label: 'new', icon: 'i-lucide-circle-dot', color: 'info' },
  triaged: { label: 'triaged', icon: 'i-lucide-circle-dashed', color: 'warning' },
  closed: { label: 'closed', icon: 'i-lucide-circle-check', color: 'success' },
}

export function feedbackStatusMeta(status: string): BadgeMeta {
  return (
    FEEDBACK_STATUS_META[status] ?? { label: status, icon: 'i-lucide-circle', color: 'neutral' }
  )
}

const FEEDBACK_KIND_META: Record<string, BadgeMeta> = {
  bug: { label: 'bug', icon: 'i-lucide-bug', color: 'error' },
  idea: { label: 'idea', icon: 'i-lucide-lightbulb', color: 'info' },
  praise: { label: 'praise', icon: 'i-lucide-heart', color: 'success' },
  confusion: { label: 'confusion', icon: 'i-lucide-circle-question-mark', color: 'warning' },
  churn: { label: 'churn', icon: 'i-lucide-circle-x', color: 'error' },
  other: { label: 'other', icon: 'i-lucide-message-square', color: 'neutral' },
}

export function feedbackKindMeta(kind: string): BadgeMeta {
  return FEEDBACK_KIND_META[kind] ?? FEEDBACK_KIND_META.other!
}

/** Day only — for "joined", "expires", anything where the hour is noise. */
export function formatDay(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/**
 * Date and time — for the audit trail and the feedback queue, where "which of
 * these two happened first" is the entire question being asked.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Audit metadata is flat scalars by design — render it as flat scalars. */
export function metadataPairs(
  metadata: Record<string, string | number | boolean | null> | null | undefined,
): { key: string; value: string }[] {
  if (!metadata) return []
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: value === null ? '—' : String(value),
  }))
}
