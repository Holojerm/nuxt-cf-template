// The full taxonomy of email event types this app can send, and the one rule
// that must hold everywhere else in the codebase: billing and security mail
// is mandatory. That rule lives HERE, not as a column on
// `notification_preferences` (server/db/schema.ts) — see the comment on that
// table for why there must never be one: the moment the exemption is a row,
// a bad UPDATE or a helpful admin can switch off the email that tells someone
// their card was declined.
//
// Every event type is namespaced `<class>.<name>` for the mandatory classes,
// or a bare name for the handful of optional ones. isMandatoryNotification()
// checks the class PREFIX rather than an enumerated list of exact strings, so
// a brand-new `billing.something_wave_7_invents` is mandatory the moment it's
// written — nobody has to remember to add it to an allowlist for the
// exemption to hold. This is still the "hardcoded allowlist" the schema
// comment describes; it's just an allowlist of prefixes instead of exact
// strings, which is the version that can't go stale.
//
// In `shared/` rather than `server/utils/` because the /account preferences
// UI needs the same optional-type list and copy the API validates against —
// two hand-typed copies is how a toggle appears in the UI for an event type
// the server 400s on, or vice versa.

/** Classes of mail nobody can opt out of: money, account security, account lifecycle. */
const MANDATORY_PREFIXES = ['billing.', 'security.', 'account.'] as const

/**
 * True for any event type in a mandatory class.
 *
 * Consulted in two places, and both matter:
 *   - server/utils/notifications.ts › isNotificationEnabled — short-circuits
 *     to true before the preferences table is ever read, so no row can
 *     suppress a mandatory send.
 *   - server/utils/email.ts › sendEmail — refuses to attach a List-Unsubscribe
 *     header to a mandatory send, even if a caller passes one by mistake.
 */
export function isMandatoryNotification(eventType: string): boolean {
  return MANDATORY_PREFIXES.some((prefix) => eventType.startsWith(prefix))
}

/**
 * Event types a user CAN opt out of, plus the copy the /account preferences
 * section renders for each. Keep this exhaustive — it's also the Zod enum
 * `PUT /api/account/notifications` validates against, so an event type left
 * off this list can never be toggled from the API either, and it can never
 * collide with a mandatory prefix above (none of these start with `billing.`,
 * `security.`, or `account.`).
 *
 * `product_updates` and `referral` are reserved for later waves — no email
 * sends for either yet, but the preference exists so someone who opts out
 * today isn't surprised the day that email ships.
 */
export const OPTIONAL_NOTIFICATION_EVENT_TYPES = ['welcome', 'product_updates', 'referral'] as const

export type OptionalNotificationEventType = (typeof OPTIONAL_NOTIFICATION_EVENT_TYPES)[number]

export function isOptionalNotificationEventType(
  value: string,
): value is OptionalNotificationEventType {
  return (OPTIONAL_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
}

export interface OptionalNotificationCopy {
  label: string
  description: string
}

/** Rendered by the /account "Email preferences" section, keyed by event type. */
export const OPTIONAL_NOTIFICATION_COPY: Record<
  OptionalNotificationEventType,
  OptionalNotificationCopy
> = {
  welcome: {
    label: 'Welcome email',
    description: 'A one-time note when your account is first created.',
  },
  product_updates: {
    label: 'Product updates',
    description: 'Occasional email about new features and changes.',
  },
  referral: {
    label: 'Referral program',
    description: 'Updates about referral rewards and program changes.',
  },
}
