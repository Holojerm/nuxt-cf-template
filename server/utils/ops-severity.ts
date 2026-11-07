// How loud each ops event kind is, for the fleet dashboard's alerts (see ops in
// server/utils/fleet-status.ts).
//
// The tiers are about what the owner has to do, not how alarming the word in
// the kind sounds:
//
// - critical — the app has stopped doing its job: requests failing wholesale,
//   payments being dropped, the thing it exists for not happening. The
//   dashboard's subject leads with [Critical]; a mail filter on it makes the phone buzz.
// - warning — one part is degraded. Worth a look today. Also the tier of every
//   kind nobody registered: a new failure path is seen before anyone decides
//   it can be quiet.
// - info — the system handled it, or it is a known setup state. The dashboard
//   decides how long these wait.
//
// Core knows one kind, `server_error`, and escalates it on a burst. A feature
// layer or a fork registers its own kinds from a Nitro plugin, next to the
// `recordOpsEvent` calls that spool them (layers/billing does this in
// billing-extensions.ts). A plain registry rather than Nitro hooks for the reason
// server/utils/extensions.ts gives: tests drive the classifier without booting Nitro.

export type OpsSeverity = 'critical' | 'warning' | 'info'

export interface OpsKindPolicy {
  severity: OpsSeverity
  /** One line on what to check first. */
  action?: string
}

/**
 * Decides a kind's severity. `count` is how many rows of that kind landed in
 * the window, so a burst can escalate (one 5xx is a warning, a wall of them
 * is not).
 */
export type OpsClassifier = (kind: string, count: number) => OpsKindPolicy

/**
 * 5xxs inside the 24 h window that mean the app is broken, not one route. Fleet mails a
 * critical within minutes, so this sits well above a normal day's handful of errors.
 */
export const SERVER_ERROR_CRITICAL_COUNT = 50

const SERVER_ERROR_BURST: OpsKindPolicy = {
  severity: 'critical',
  action:
    'Many requests are failing at once. Open the logs; check /api/status for pending migrations.',
}

const policies = new Map<string, OpsKindPolicy>()

/**
 * Give kinds a tier and, for the loud ones, a one-line "what to do". Later
 * registrations of the same kind win, so a fork can re-tier a layer's kind.
 */
export function registerOpsSeverity(table: Record<string, OpsKindPolicy>): void {
  for (const [kind, policy] of Object.entries(table)) policies.set(kind, policy)
}

/** Test-only. */
export function resetOpsSeverityForTest(): void {
  policies.clear()
}

/** The classifier collectFleetCounters() ranks kinds with. */
export const classifyOps: OpsClassifier = (kind, count) => {
  const registered = policies.get(kind)
  if (registered) return registered
  if (kind === 'server_error') {
    return count >= SERVER_ERROR_CRITICAL_COUNT ? SERVER_ERROR_BURST : { severity: 'warning' }
  }
  return { severity: 'warning' }
}
