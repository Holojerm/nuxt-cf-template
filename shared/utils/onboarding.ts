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

/**
 * The known arms of the 'onboarding-layout' PostHog flag. One list, passed
 * to BOTH sides that need to agree on it:
 *   - app/pages/dashboard.vue passes this to useFlagVariant's `allowed`
 *     param (app/composables/useFlag.ts), which clamps anything PostHog
 *     returns that isn't in this list back to the fallback — so an arm
 *     added in the PostHog dashboard before it's added here renders (and,
 *     see below, records) as the fallback, not as itself.
 *   - The Zod body of POST /api/onboarding/activated, and by extension the
 *     `onboarding_layout_variant` property on the `user_activated` PostHog
 *     event, both validate against this same enum.
 *
 * Add an arm here BEFORE configuring it in the PostHog dashboard, not
 * after — the client-side clamp means the order the other way round just
 * means visitors bucketed into the new arm quietly get the control
 * experience (and their activations record as 'control') until this list
 * catches up, rather than anything failing loudly. This value is still
 * client-asserted either way — the browser is what resolved the flag, and
 * the server has no independent way to check which arm a given visitor was
 * actually shown — the clamp only guarantees it's one of these two.
 */
export const ONBOARDING_LAYOUT_VARIANTS = ['control', 'compact'] as const
export const onboardingLayoutVariantSchema = z.enum(ONBOARDING_LAYOUT_VARIANTS)
export type OnboardingLayoutVariant = z.infer<typeof onboardingLayoutVariantSchema>

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
 * What GET /api/onboarding actually returns on the wire: the pure
 * derivation above, plus one fact that derivation can't know about because
 * it isn't one of the four checklist signals — whether this account's
 * `user_activated` event has already been recorded (server/utils/onboarding.ts
 * › hasActivated). Kept as a separate schema, extending rather than folding
 * into onboardingProgressSchema, because `deriveOnboardingSteps` below has
 * to stay pure and D1-independent — see the module comment — and `activated`
 * is neither of those.
 *
 * The client (app/pages/dashboard.vue) uses it to skip
 * POST /api/onboarding/activated entirely once it's already true, rather
 * than calling an endpoint whose only job at that point is to say no.
 */
export const onboardingStatusSchema = onboardingProgressSchema.extend({
  activated: z.boolean(),
})
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>

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

export interface ActivationAttemptState {
  /** From useFlagVariant's `settled` (app/composables/useFlag.ts) — true
   * once the A/B flag has actually reported a value, or been confirmed to
   * have nothing to report. NOT the same question as "has the variant
   * changed" — see that file for why conflating the two was the bug. */
  settled: boolean
  complete: boolean
  /** From GET /api/onboarding's own response — true once this account has
   * already been recorded, so a returning visitor's page load doesn't
   * bother asking again. */
  activated: boolean
}

/**
 * Whether app/pages/dashboard.vue should attempt
 * POST /api/onboarding/activated right now. Pulled out of that page's
 * tryRecordActivation() as a pure function so the decision criteria are
 * directly testable (test/onboarding.test.ts) without mounting the page.
 *
 * This only answers "are the preconditions met on THIS call" — it has no
 * memory of previous calls. The "attempt at most once, ever, this page
 * load" half is the caller's job: a closure boolean set synchronously
 * before the resulting network call, the way dashboard.vue does it. That
 * half can't be a pure function of this state on its own, because "have I
 * already tried" is exactly the thing a pure function of the CURRENT state
 * has no way to know — see test/onboarding.test.ts for a test that
 * exercises the two together, the way the real page does.
 */
export function shouldAttemptActivation(state: ActivationAttemptState): boolean {
  return state.settled && state.complete && !state.activated
}
