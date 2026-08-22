// The first-run checklist's derivation — pure, so this exercises the full
// input matrix directly rather than standing up a database. The one rule
// worth testing beyond "each flag maps to its step" is ordering: `next` must
// always be the first incomplete step in ONBOARDING_STEP_IDS order, even
// when a later step finishes before an earlier one.

import { describe, expect, it } from 'vitest'
import { deriveOnboardingSteps, ONBOARDING_STEP_IDS } from '../shared/utils/onboarding'
import type { OnboardingInputs } from '../shared/utils/onboarding'

const NONE_DONE: OnboardingInputs = {
  entitlementActive: false,
  hasNotificationPreference: false,
  hasConnectedClient: false,
  hasSentFeedback: false,
}

const ALL_DONE: OnboardingInputs = {
  entitlementActive: true,
  hasNotificationPreference: true,
  hasConnectedClient: true,
  hasSentFeedback: true,
}

describe('deriveOnboardingSteps — shape', () => {
  it('returns all four steps in ONBOARDING_STEP_IDS order, every time', () => {
    const progress = deriveOnboardingSteps(NONE_DONE)
    expect(progress.steps.map((step) => step.id)).toEqual([...ONBOARDING_STEP_IDS])
    expect(progress.total).toBe(4)
  })

  it('every step carries a non-empty label and a real action', () => {
    const { steps } = deriveOnboardingSteps(NONE_DONE)
    for (const step of steps) {
      expect(step.label.length).toBeGreaterThan(0)
      expect(step.action.label.length).toBeGreaterThan(0)
      expect(step.action.to.startsWith('/')).toBe(true)
    }
  })
})

describe('deriveOnboardingSteps — nothing done', () => {
  const progress = deriveOnboardingSteps(NONE_DONE)

  it('marks every step incomplete', () => {
    expect(progress.steps.every((step) => step.done === false)).toBe(true)
    expect(progress.completed).toBe(0)
    expect(progress.complete).toBe(false)
  })

  it('points `next` at the first step', () => {
    expect(progress.next?.id).toBe('plan')
  })
})

describe('deriveOnboardingSteps — everything done', () => {
  const progress = deriveOnboardingSteps(ALL_DONE)

  it('marks every step done and the whole checklist complete', () => {
    expect(progress.steps.every((step) => step.done === true)).toBe(true)
    expect(progress.completed).toBe(4)
    expect(progress.complete).toBe(true)
  })

  it('has no next step', () => {
    expect(progress.next).toBeNull()
  })
})

describe('deriveOnboardingSteps — one signal at a time', () => {
  it.each([
    ['entitlementActive', 'plan'],
    ['hasConnectedClient', 'connect'],
    ['hasNotificationPreference', 'notifications'],
    ['hasSentFeedback', 'feedback'],
  ] as const)('turning on %s completes only the %s step', (key, stepId) => {
    const progress = deriveOnboardingSteps({ ...NONE_DONE, [key]: true })
    const step = progress.steps.find((candidate) => candidate.id === stepId)
    expect(step?.done).toBe(true)
    expect(progress.completed).toBe(1)
    expect(progress.steps.filter((candidate) => candidate.done)).toHaveLength(1)
  })
})

describe('deriveOnboardingSteps — next follows step order, not completion order', () => {
  it('finishing feedback and connect first still points next at plan', () => {
    const progress = deriveOnboardingSteps({
      entitlementActive: false,
      hasNotificationPreference: false,
      hasConnectedClient: true,
      hasSentFeedback: true,
    })
    expect(progress.completed).toBe(2)
    expect(progress.next?.id).toBe('plan')
  })

  it('with only the last step left, next is feedback', () => {
    const progress = deriveOnboardingSteps({
      entitlementActive: true,
      hasNotificationPreference: true,
      hasConnectedClient: true,
      hasSentFeedback: false,
    })
    expect(progress.completed).toBe(3)
    expect(progress.next?.id).toBe('feedback')
  })
})

describe('deriveOnboardingSteps — omitted optional input', () => {
  it('treats a missing hasSentFeedback as not done, not as an error', () => {
    const { entitlementActive, hasNotificationPreference, hasConnectedClient } = ALL_DONE
    const progress = deriveOnboardingSteps({
      entitlementActive,
      hasNotificationPreference,
      hasConnectedClient,
    })
    expect(progress.steps.find((step) => step.id === 'feedback')?.done).toBe(false)
    expect(progress.complete).toBe(false)
    expect(progress.next?.id).toBe('feedback')
  })
})

describe('deriveOnboardingSteps — the plan step on /dashboard', () => {
  // /dashboard's own subscription middleware already refuses entry to
  // anyone without an active entitlement (app/middleware/subscription.ts),
  // so entitlementActive is structurally true for every real visitor to
  // this checklist. This function doesn't assume that — it just reports
  // whatever it's given — which this test pins down explicitly.
  it('reads the plan step as done whenever entitlementActive is true, independent of everything else', () => {
    const progress = deriveOnboardingSteps({ ...NONE_DONE, entitlementActive: true })
    expect(progress.steps[0]).toMatchObject({ id: 'plan', done: true })
  })
})
