// The database half of the first-run checklist — everything the two
// /api/onboarding* endpoints need that the pure derivation in
// shared/utils/onboarding.ts can't know on its own: where the four signals
// come from, and the one-time activation event that fires when they're all
// true for the first time.
//
// Like server/utils/audit.ts and server/utils/notifications.ts, every
// function here takes the Drizzle client as its first argument instead of
// reaching for the auto-imported `db`, so test/onboarding-activation.test.ts
// can drive this against a real D1 binding inside workerd without booting
// Nitro.

import { and, eq, isNotNull } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import { deriveOnboardingSteps } from '#shared/utils/onboarding'
import type { OnboardingInputs, OnboardingLayoutVariant } from '#shared/utils/onboarding'
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
 * Whether `onboarding.activated` has already been recorded for this
 * account — one indexed read against `audit_log`. Factored out so the two
 * callers that both need this exact question answered (recordActivationOnce's
 * own guard below, and activateIfComplete's early exit, which skips the four
 * reads in computeOnboardingInputs entirely once this is true) share one
 * query instead of hand-copying it, and so GET /api/onboarding — which asks
 * the same question purely to report `activated` in its response, never to
 * write anything — can reuse it too.
 */
export async function hasActivated(db: OnboardingDb, userId: string): Promise<boolean> {
  const existing = await db.query.auditLog.findFirst({
    where: and(
      eq(tables.auditLog.actorUserId, userId),
      eq(tables.auditLog.action, 'onboarding.activated'),
    ),
    columns: { id: true },
  })
  return Boolean(existing)
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
 * the one event a product most wants to be able to trust.
 *
 * ── Why called from POST /api/onboarding/activated, not GET /api/onboarding ──
 * It used to live in the GET handler, gated on `progress.complete`. That was
 * wrong in a way that made the whole 'onboarding-layout' experiment
 * unmeasurable: GET /api/onboarding runs once per page load, during the
 * SAME `<script setup>` tick as `useFlagVariant()` — before onMounted, which
 * is the earliest point that composable ever resolves past its fallback
 * (app/composables/useFlag.ts). So the FIRST GET that ever observed
 * `complete: true` — the one call in this account's whole lifetime that
 * burns the idempotency guard below — always ran with the flag's fallback
 * value, never the visitor's real arm. A later, correctly-tagged GET (after
 * the flag resolved) would find the guard already tripped and record
 * nothing. Every real activation landed tagged as the fallback arm.
 *
 * Splitting the write out to its own endpoint, called by the client once it
 * has BOTH `complete: true` and a resolved variant in hand
 * (app/pages/dashboard.vue — gated on useFlagVariant's `settled`, not on
 * the variant merely changing; see app/composables/useFlag.ts for why that
 * distinction is load-bearing), fixes that: the tag recorded is the one the
 * visitor actually saw. GET /api/onboarding is now purely a read (and
 * fetched once, not twice — see that file).
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * An `audit_log` row with action `onboarding.activated` (actorType `user`,
 * actorUserId = targetId = this user) is the guard: if one already exists,
 * the event has fired before and this call is a no-op — see hasActivated()
 * below, which owns the actual query. The row is written via `withAudit` —
 * audit before act (server/utils/audit.ts) — so a dropped PostHog capture
 * can never leave the guard un-set: the row lands first, the capture
 * attempt happens after, and either way the next call sees the row and
 * skips.
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
  variant: OnboardingLayoutVariant,
): Promise<boolean> {
  if (await hasActivated(db, userId)) return false

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
        // through by the caller — see server/api/onboarding/activated.post.ts.
        // Without this the 'onboarding-layout' experiment would have no
        // outcome metric to compare arms on.
        properties: { onboarding_layout_variant: variant },
      }),
  )
  return true
}

export interface ActivateIfCompleteResult {
  activated: boolean
}

/**
 * The full decision behind POST /api/onboarding/activated: recompute the
 * checklist from scratch — never trust the caller's claim that it's
 * complete, the same way no other privileged write in this app trusts
 * client-supplied state for something it alone decides to record — and only
 * defer to recordActivationOnce() once that's independently verified true.
 *
 * Checks hasActivated() FIRST, before paying for computeOnboardingInputs's
 * four reads. This matters because this function's steady-state caller is
 * not "the moment someone finishes onboarding" — it's every dashboard load
 * for every account that already has, forever (app/pages/dashboard.vue
 * calls POST /api/onboarding/activated once per visit until GET
 * /api/onboarding reports `activated: true`, at which point the client
 * stops calling it at all — but every visit before that first GET refresh
 * lands here). One indexed read to say "nothing to do" beats four just to
 * throw the answer away.
 *
 * Factored out of the endpoint (which is otherwise a two-line wrapper
 * around this and a session check) so the "not complete yet ⇒ no write, no
 * matter what the client thinks" behavior is directly testable without an
 * H3 event — see test/onboarding-activation.test.ts.
 */
export async function activateIfComplete(
  db: OnboardingDb,
  userId: string,
  variant: OnboardingLayoutVariant,
  options: ComputeOnboardingInputsOptions,
): Promise<ActivateIfCompleteResult> {
  if (await hasActivated(db, userId)) return { activated: false }

  const inputs = await computeOnboardingInputs(db, userId, options)
  const progress = deriveOnboardingSteps(inputs)

  if (!progress.complete) return { activated: false }

  return { activated: await recordActivationOnce(db, userId, variant) }
}
