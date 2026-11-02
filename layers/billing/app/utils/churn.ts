// Cancellation reasons, asked once on /account immediately before we hand the
// customer to Paddle's portal.
//
// ── Why here, and why it must not block ──────────────────────────────────────
// Cancelling happens on Paddle's hosted checkout portal — a different origin,
// where neither a PostHog survey nor anything else of ours can run. The moment
// just before the redirect is the only place this question can be asked at all.
//
// It is a question, never a gate. The prompt's primary button continues to the
// portal whether or not anything is selected, there is no "are you sure", and
// no offer is inserted to change their mind. A retention flow that makes
// leaving harder is the dark pattern this page exists to avoid, and it is
// illegal in several jurisdictions. Answers land as `kind: 'churn'` feedback.

export interface CancelReason {
  /** Stored verbatim as the feedback message when no detail is added. */
  value: string
  label: string
}

/**
 * Deliberately short and non-leading. Six options is about the limit before
 * people stop reading and pick the first plausible one, which is how churn
 * surveys end up "proving" whatever sits at the top of the list.
 */
export const CANCEL_REASONS: CancelReason[] = [
  { value: 'too_expensive', label: "It's too expensive" },
  { value: 'missing_feature', label: "It's missing something I need" },
  { value: 'not_using', label: "I'm not using it enough" },
  { value: 'too_hard', label: 'It was harder to use than I expected' },
  { value: 'found_alternative', label: 'I found something else' },
  { value: 'other', label: 'Something else' },
]

/** Compose the stored message: the chosen reason, plus any detail they typed. */
export function cancelFeedbackMessage(reason: string | null | undefined, detail: string): string {
  const label = CANCEL_REASONS.find((r) => r.value === reason)?.label ?? 'No reason given'
  const trimmed = detail.trim()
  return trimmed ? `${label} — ${trimmed}` : label
}
