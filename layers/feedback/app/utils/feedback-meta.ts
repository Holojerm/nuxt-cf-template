// Badge labels, icons and colors for feedback kind and status, shared by the
// queue (/admin/feedback) and the admin one-customer card.

import type { BadgeMeta } from '~/utils/admin'

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
