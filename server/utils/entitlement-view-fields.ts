// Extra fields on the customer's billing view, contributed by whoever needs them.
//
// buildEntitlementView() (entitlement-view.ts) is a layer util, so an app cannot
// shadow it, and a copy would put the customer's screen and the support
// console's "view as" out of step. An app (or another feature) that needs one
// more field on GET /api/billing/entitlement, on the admin views, or on each
// history row registers it here instead:
//
//   declare module '#server/utils/entitlement-view-fields' {
//     interface EntitlementHistoryFields { referralKind: 'welcome' | 'reward' | null }
//   }
//   registerEntitlementViewFields({
//     key: 'referral',
//     history: (row) => ({ referralKind: referralRefKind(row.paddleSubscriptionId) }),
//   })
//
// The augmentation types the field all the way to the page that reads it.
//
// ── Why this is core's file, not billing's ───────────────────────────────────
// The referral loop adds fields to this view and must not import the billing
// layer to do it. The registry therefore lives here, typed against the one fact
// a contributor can always rely on (the ref in `paddleSubscriptionId`); the
// billing layer widens `EntitlementViewRow` and the context with its own types
// by augmentation (layers/billing/server/utils/entitlement-view.ts), which is
// how billing's own code and tests see the full row and the overview.
//
// ── Rules ────────────────────────────────────────────────────────────────────
// - Registered from a Nitro plugin, like every other seam; tests call it directly.
// - With nothing registered the view is exactly what it was: no field, no
//   reordering, no extra query.
// - Additive only. A field the base view already has is never overwritten (a
//   contributor cannot corrupt the wire shape the client depends on); the
//   attempt is logged as `billing_view_field_collision`. Between contributors,
//   the one registered later wins.
// - A contributor that throws is logged (`billing_view_fields_failed`) and
//   skipped: this view feeds /account, the paywall and the support console, and
//   an optional field must not take them down.
// - `history` is a pure function of the row. `view` may read, never write.

import type { ExtensionDb } from './extensions'

/** Fields added to the top level of the view. Augment with `declare module`. */
export interface EntitlementViewFields {}

/** Fields added to every `history[]` row. Augment with `declare module`. */
export interface EntitlementHistoryFields {}

/**
 * One entitlement row, as far as a contributor may depend on it. The billing
 * layer augments this with the whole row.
 */
export interface EntitlementViewRow {
  /** The ref: `sub_…`, `txn_…`, `comp_…`, or a derived grant's own prefix. */
  paddleSubscriptionId: string
}

export interface EntitlementViewFieldsContext {
  db: ExtensionDb
  userId: string
  /** The row that describes the plan: a live subscription, else the access row, else null. */
  describing: EntitlementViewRow | null
}

export interface EntitlementViewFieldsContributor {
  key: string
  /** Extra top-level fields. */
  view?: (
    context: EntitlementViewFieldsContext,
  ) => Partial<EntitlementViewFields> | Promise<Partial<EntitlementViewFields>>
  /** Extra fields for one history row. */
  history?: (entitlement: EntitlementViewRow) => Partial<EntitlementHistoryFields>
}

// Keyed, so a plugin and a test (or a dev reload) registering the same
// contributor replace rather than duplicate it.
const contributors = new Map<string, EntitlementViewFieldsContributor>()

export function registerEntitlementViewFields(contributor: EntitlementViewFieldsContributor): void {
  contributors.set(contributor.key, contributor)
}

/** Test-only: forget every contributor. */
export function clearEntitlementViewFieldsForTest(): void {
  contributors.clear()
}

function logFailure(kind: string, key: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ kind, contributor: key, ...detail }))
}

/** Copies `extra` onto `target`, skipping (and logging) any key `target` already has. */
function mergeAdditive(
  target: Record<string, unknown>,
  extra: Record<string, unknown>,
  key: string,
  base: ReadonlySet<string>,
): void {
  for (const [field, value] of Object.entries(extra)) {
    if (base.has(field)) {
      logFailure('billing_view_field_collision', key, { field })
      continue
    }
    target[field] = value
  }
}

/**
 * Applies every contributor's top-level fields to `view` and returns it.
 * Mutates and returns the same object, so a view with no contributors is the
 * very object that was built.
 */
export async function applyEntitlementViewFields<T extends object>(
  view: T,
  context: EntitlementViewFieldsContext,
): Promise<T & EntitlementViewFields> {
  if (contributors.size === 0) return view as T & EntitlementViewFields
  const base = new Set(Object.keys(view))
  for (const [key, contributor] of contributors) {
    if (!contributor.view) continue
    try {
      mergeAdditive(view as Record<string, unknown>, await contributor.view(context), key, base)
    } catch (error) {
      logFailure('billing_view_fields_failed', key, { scope: 'view', error: String(error) })
    }
  }
  return view as T & EntitlementViewFields
}

/** As `applyEntitlementViewFields`, for one history row. */
export function applyEntitlementHistoryFields<T extends object>(
  row: T,
  entitlement: EntitlementViewRow,
): T & EntitlementHistoryFields {
  if (contributors.size === 0) return row as T & EntitlementHistoryFields
  const base = new Set(Object.keys(row))
  for (const [key, contributor] of contributors) {
    if (!contributor.history) continue
    try {
      mergeAdditive(row as Record<string, unknown>, contributor.history(entitlement), key, base)
    } catch (error) {
      logFailure('billing_view_fields_failed', key, { scope: 'history', error: String(error) })
    }
  }
  return row as T & EntitlementHistoryFields
}
