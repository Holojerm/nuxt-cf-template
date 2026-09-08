// The first-run checklist, as data. This is the per-product file: a fork adds,
// removes or reorders steps here and never touches the engine in
// shared/utils/onboarding.ts, which turns these into progress the dashboard
// renders and POST /api/onboarding/activated re-checks server-side.
//
// Lives in shared/ rather than app/ because the SERVER derives the steps too
// (GET /api/onboarding returns them; activation must not trust the client), and
// app/ is not importable from server/.

import type { OnboardingInputs } from './onboarding'

export const ONBOARDING_STEP_IDS = ['plan', 'notifications', 'feedback'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]

export interface OnboardingStepDefinition {
  id: OnboardingStepId
  label: string
  /** A route to navigate to. The 'feedback' step's action is not a plain
   * link — the UI embeds <FeedbackWidget position="inline"> for that step
   * instead (see Checklist.vue) — so this is a same-page fallback for that
   * one, never actually followed. */
  action: { label: string; to: string }
  done: (inputs: OnboardingInputs) => boolean
}

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    id: 'plan',
    label: 'Pick a plan',
    action: { label: 'View plans', to: '/pricing' },
    done: (inputs) => inputs.entitlementActive,
  },
  {
    id: 'notifications',
    label: 'Set your email preferences',
    action: { label: 'Set preferences', to: '/account' },
    done: (inputs) => inputs.hasNotificationPreference,
  },
  {
    id: 'feedback',
    label: 'Send us feedback',
    action: { label: 'Send feedback', to: '/dashboard' },
    done: (inputs) => Boolean(inputs.hasSentFeedback),
  },
]
