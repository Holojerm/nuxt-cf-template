// The first-run checklist shown on /dashboard — what steps exist, whether
// each is done, and what to do next. Pure and dependency-free on purpose: it
// takes the four facts it needs as plain booleans and returns data, nothing
// else, so the whole matrix is unit-testable without a database or a
// component (see test/onboarding.test.ts). The facts themselves are gathered
// from D1 in server/utils/onboarding.ts, which is the only thing that knows
// where each one comes from.
//
// In shared/ rather than server/ or app/ because both sides need the exact
// same shape: server/api/onboarding.get.ts returns it, and
// app/components/Onboarding/Checklist.vue renders it — two hand-typed copies
// is how the count in "2 of 4" and the number of rows in the list drift apart.

import { z } from 'zod'

/**
 * Ordered on purpose — this is the sequence the checklist renders in, and
 * `next` always resolves to the first `done: false` entry in this order.
 * Doing a later step before an earlier one (e.g. sending feedback before
 * connecting a client) still leaves the right thing highlighted as "next".
 */
export const ONBOARDING_STEP_IDS = ['plan', 'connect', 'notifications', 'feedback'] as const

export const onboardingStepIdSchema = z.enum(ONBOARDING_STEP_IDS)
export type OnboardingStepId = z.infer<typeof onboardingStepIdSchema>

export const onboardingStepActionSchema = z.object({
  label: z.string(),
  /** A route to navigate to. The 'feedback' step's action is not a plain
   * link — the UI embeds <FeedbackWidget position="inline"> for that step
   * instead (see Checklist.vue) — so this is a same-page fallback for that
   * one, never actually followed. */
  to: z.string(),
})
export type OnboardingStepAction = z.infer<typeof onboardingStepActionSchema>

export const onboardingStepSchema = z.object({
  id: onboardingStepIdSchema,
  label: z.string(),
  done: z.boolean(),
  action: onboardingStepActionSchema,
})
export type OnboardingStep = z.infer<typeof onboardingStepSchema>

export const onboardingProgressSchema = z.object({
  steps: z.array(onboardingStepSchema),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  complete: z.boolean(),
  /** The first incomplete step, in ONBOARDING_STEP_IDS order. Null once
   * `complete` is true. */
  next: onboardingStepSchema.nullable(),
})
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>

/**
 * The raw signals the checklist is derived from. Each one is a fact that
 * already lives somewhere else in the app — no new table backs this feature.
 * See server/utils/onboarding.ts › computeOnboardingInputs for exactly how
 * each is read from D1.
 */
export interface OnboardingInputs {
  /**
   * From buildEntitlementView(...).active (server/utils/entitlement-view.ts).
   *
   * On /dashboard this is always true in practice: `definePageMeta({
   * middleware: ['auth', 'subscription'] })` already redirects anyone
   * without an active entitlement to /pricing (or /account, if they're
   * `past_due`) before this page ever renders — see
   * app/middleware/subscription.ts. So "pick a plan" reads as done for
   * every real visitor to this checklist, and the honest reason is
   * structural, not that the step is fake: the gate that makes it true is
   * the same gate that put the checklist in front of them at all.
   *
   * The alternative — moving this step onto /pricing's gated alert instead
   * — was considered and rejected: /pricing is explicitly out of scope this
   * wave (owned by another agent), and splitting one checklist's state
   * across two pages (one step lives on /pricing, three live on /dashboard)
   * is a worse user model than "the whole checklist lives where you land
   * once you're in." Keeping the input here rather than hardcoding `done:
   * true` on the step also means this function stays correct if the
   * checklist is ever reused somewhere reachable without an entitlement.
   */
  entitlementActive: boolean
  /**
   * Whether this user has saved at least one row in
   * `notification_preferences` — i.e. visited /account and made an explicit
   * choice, not merely inheriting the default-on state every account starts
   * in (server/db/schema.ts — absence of a row means default-on).
   */
  hasNotificationPreference: boolean
  /**
   * Whether a minted MCP connect code for this user has actually been
   * redeemed (`used_at` set) — not just requested. Minting one only proves
   * intent (someone clicked "Generate code"); redemption, written by the
   * MCP worker into the same D1 table (mcp/src/authorize.ts), is the fact
   * that a client is actually connected.
   */
  hasConnectedClient: boolean
  /**
   * Whether this user has ever submitted feedback (any row in `feedback`
   * for their id). Optional because a caller may not always compute it —
   * treated as `false` when omitted, the same "unknown degrades to
   * incomplete" default every other input effectively has.
   */
  hasSentFeedback?: boolean
}

/**
 * Turn the four raw signals into the ordered, renderable checklist.
 */
export function deriveOnboardingSteps(inputs: OnboardingInputs): OnboardingProgress {
  const steps: OnboardingStep[] = [
    {
      id: 'plan',
      label: 'Pick a plan',
      done: inputs.entitlementActive,
      action: { label: 'View plans', to: '/pricing' },
    },
    {
      id: 'connect',
      label: 'Connect an AI client',
      done: inputs.hasConnectedClient,
      action: { label: 'Connect a client', to: '/account' },
    },
    {
      id: 'notifications',
      label: 'Set your email preferences',
      done: inputs.hasNotificationPreference,
      action: { label: 'Set preferences', to: '/account' },
    },
    {
      id: 'feedback',
      label: 'Send us feedback',
      done: Boolean(inputs.hasSentFeedback),
      action: { label: 'Send feedback', to: '/dashboard' },
    },
  ]

  const completed = steps.filter((step) => step.done).length

  return onboardingProgressSchema.parse({
    steps,
    completed,
    total: steps.length,
    complete: completed === steps.length,
    next: steps.find((step) => !step.done) ?? null,
  })
}
