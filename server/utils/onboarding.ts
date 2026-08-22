// The database half of the first-run checklist — everything GET
// /api/onboarding needs that the pure derivation in shared/utils/onboarding.ts
// can't know on its own: where the four signals come from, and the one-time
// activation event that fires when they're all true for the first time.
//
// Like server/utils/audit.ts and server/utils/notifications.ts, every
// function here takes the Drizzle client as its first argument instead of
// reaching for the auto-imported `db`, so test/onboarding-activation.test.ts
// can drive this against a real D1 binding inside workerd without booting
// Nitro.

import { and, eq, isNotNull } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { OnboardingInputs } from '#shared/utils/onboarding'
import { withAudit } from './audit'
import { buildEntitlementView } from './entitlement-view'
import { captureServerEvent } from './posthog'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type OnboardingDb = ReturnType<typeof drizzle<typeof tables>>

export interface ComputeOnboardingInputsOptions {
  /** Passed straight through to buildEntitlementView — see its own comment
   * on why this must be an explicit argument rather than a default. Unused
   * by this function beyond that: the checklist only reads `.active`. */
  portalConfigured: boolean
}

/**
 * Gather the four signals the checklist is built from, in one `Promise.all`:
 * the entitlement view (already its own small, bounded number of reads — see
 * server/utils/entitlement-view.ts) plus one indexed exists-style query per
 * remaining step. Nothing here is a table scan.
 */
export async function computeOnboardingInputs(
  db: OnboardingDb,
  userId: string,
  options: ComputeOnboardingInputsOptions,
): Promise<OnboardingInputs> {
  const [entitlement, notificationRow, connectedCodeRow, feedbackRow] = await Promise.all([
    buildEntitlementView(db, userId, options),
    db.query.notificationPreferences.findFirst({
      where: eq(tables.notificationPreferences.userId, userId),
      columns: { id: true },
    }),
    // `usedAt` is written by the MCP worker on redemption (mcp/src/authorize.ts
    // — same D1 database, shared by `database_id`), not by minting the code.
    // Minting only proves someone clicked "Generate code" on /account;
    // redemption is the fact that a client is actually connected.
    db.query.mcpConnectCodes.findFirst({
      where: and(
        eq(tables.mcpConnectCodes.userId, userId),
        isNotNull(tables.mcpConnectCodes.usedAt),
      ),
      columns: { id: true },
    }),
    db.query.feedback.findFirst({
      where: eq(tables.feedback.userId, userId),
      columns: { id: true },
    }),
  ])

  return {
    entitlementActive: entitlement.active,
    hasNotificationPreference: Boolean(notificationRow),
    hasConnectedClient: Boolean(connectedCodeRow),
    hasSentFeedback: Boolean(feedbackRow),
  }
}

/**
 * Fire `user_activated` exactly once per account, the moment the checklist
 * is first observed complete. Returns `true` the one time it actually fires,
 * `false` on every call after (including calls where the checklist merely
 * remains complete on a later page load).
 *
 * ── Why server-side, not client-side ─────────────────────────────────────
 * The same reasoning CLAUDE.md gives for `user_signed_up`/`user_signed_in`
 * (server/utils/auth.ts) applies here: an ad blocker that drops posthog-js
 * would silently lose a client-fired activation event forever, and this is
 * the one event a product most wants to be able to trust. The endpoint that
 * renders the checklist already computed every input server-side to do
 * that, so there's no extra read to pay for also deciding "did this just
 * become true" here.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * An `audit_log` row with action `onboarding.activated` (actorType `user`,
 * actorUserId = targetId = this user) is the guard: if one already exists,
 * the event has fired before and this call is a no-op. The row is written
 * via `withAudit` — audit before act (server/utils/audit.ts) — so a dropped
 * PostHog capture can never leave the guard un-set: the row lands first,
 * the capture attempt happens after, and either way the next call sees the
 * row and skips.
 *
 * This is check-then-write, not atomic — there's no unique constraint on
 * (actor_user_id, action) backing it, and adding one is a schema change out
 * of scope for this wave. The race it leaves open is narrow: two concurrent
 * *first* completions of the same account (e.g. two tabs polling /dashboard
 * in the same instant) could both pass the check before either writes,
 * producing two audit rows and two events. That's the same class of
 * trade-off this codebase already accepts elsewhere for non-billing signals
 * — the KV rate limiter fails open and is "abuse control, not metering"
 * (server/utils/rate-limit.ts) — and the fix, if it's ever needed, is the
 * one CLAUDE.md already names for exactness: a Durable Object, not a retry
 * loop here.
 */
export async function recordActivationOnce(
  db: OnboardingDb,
  userId: string,
  variant: string,
): Promise<boolean> {
  const existing = await db.query.auditLog.findFirst({
    where: and(
      eq(tables.auditLog.actorUserId, userId),
      eq(tables.auditLog.action, 'onboarding.activated'),
    ),
    columns: { id: true },
  })
  if (existing) return false

  await withAudit(
    db,
    {
      actorUserId: userId,
      actorType: 'user',
      action: 'onboarding.activated',
      targetType: 'user',
      targetId: userId,
    },
    () =>
      captureServerEvent({
        distinctId: userId,
        event: 'user_activated',
        // The A/B variant the browser was showing when the checklist
        // completed (app/composables/useFlag.ts › useFlagVariant), passed
        // through by the caller — see server/api/onboarding.get.ts. Without
        // this the 'onboarding-layout' experiment would have no outcome
        // metric to compare arms on.
        properties: { onboarding_layout_variant: variant },
      }),
  )
  return true
}
