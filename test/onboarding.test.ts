// The first-run checklist's derivation — pure, so this exercises the full
// input matrix directly rather than standing up a database. The one rule
// worth testing beyond "each flag maps to its step" is ordering: `next` must
// always be the first incomplete step in ONBOARDING_STEP_IDS order, even
// when a later step finishes before an earlier one.

import { describe, expect, it } from 'vitest'
import {
  deriveOnboardingSteps,
  ONBOARDING_STEP_IDS,
  shouldAttemptActivation,
} from '../shared/utils/onboarding'
import type { ActivationAttemptState, OnboardingInputs } from '../shared/utils/onboarding'

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

describe('shouldAttemptActivation', () => {
  const READY: ActivationAttemptState = { settled: true, complete: true, activated: false }

  it('is true only once every precondition holds', () => {
    expect(shouldAttemptActivation(READY)).toBe(true)
  })

  it.each([
    ['not settled yet — the cold-cache case', { ...READY, settled: false }],
    ['not complete', { ...READY, complete: false }],
    ['already recorded (GET reported activated: true)', { ...READY, activated: true }],
  ] as const)('is false when %s', (_label, state) => {
    expect(shouldAttemptActivation(state)).toBe(false)
  })

  it('settled alone is not enough — a settled flag on an incomplete checklist should not fire', () => {
    expect(shouldAttemptActivation({ settled: true, complete: false, activated: false })).toBe(
      false,
    )
  })

  it('complete alone is not enough — the whole point of this function is that it is not', () => {
    expect(shouldAttemptActivation({ settled: false, complete: true, activated: false })).toBe(
      false,
    )
  })

  // The property that matters most: across a realistic sequence of watcher
  // firings — the way app/pages/dashboard.vue actually drives this, via
  // `watch([settled, () => progress.value?.complete], …, { immediate: true })`
  // plus a closure `activationAttempted` guard — the decision to attempt the
  // POST fires exactly once, and only once every precondition is actually
  // true. This simulates that call pattern directly rather than mounting
  // the page.
  describe("single-fire ordering, simulating the page's own call pattern", () => {
    function simulatePage() {
      let attempted = false
      const attempts: ActivationAttemptState[] = []

      /** Mirrors dashboard.vue's tryRecordActivation() exactly: check the
       * guard, check the pure decision, and — if both pass — record an
       * "attempt" (standing in for the real $fetch POST) and flip the
       * guard synchronously, before anything async would happen. */
      function onWatcherFired(state: ActivationAttemptState): void {
        if (attempted || !shouldAttemptActivation(state)) return
        attempted = true
        attempts.push(state)
      }

      return { onWatcherFired, attempts: () => attempts }
    }

    it('cold-cache visitor: settled arrives after complete is already known, fires once when settled catches up', () => {
      const page = simulatePage()

      // `immediate: true`'s first synchronous firing — SSR/hydration,
      // settled still false.
      page.onWatcherFired({ settled: false, complete: true, activated: false })
      // The 3s-timeout or onFeatureFlags firing, settled catches up.
      page.onWatcherFired({ settled: true, complete: true, activated: false })
      // A stray re-fire after that (e.g. onFeatureFlags firing again on a
      // flags refresh) must not attempt a second time.
      page.onWatcherFired({ settled: true, complete: true, activated: false })

      expect(page.attempts()).toHaveLength(1)
      expect(page.attempts()[0]).toEqual({ settled: true, complete: true, activated: false })
    })

    it('live completion via the embedded feedback widget: complete arrives after settled', () => {
      const page = simulatePage()

      // Flag already resolved (e.g. cached), checklist still has one step left.
      page.onWatcherFired({ settled: true, complete: false, activated: false })
      // handleFeedbackSubmitted's refresh() flips complete live.
      page.onWatcherFired({ settled: true, complete: true, activated: false })
      page.onWatcherFired({ settled: true, complete: true, activated: false })

      expect(page.attempts()).toHaveLength(1)
    })

    it('a returning visitor who already activated never attempts, however many times the watcher fires', () => {
      const page = simulatePage()

      page.onWatcherFired({ settled: false, complete: true, activated: true })
      page.onWatcherFired({ settled: true, complete: true, activated: true })

      expect(page.attempts()).toHaveLength(0)
    })

    it('PostHog unconfigured forever: settled goes true immediately and stays the only firing that matters', () => {
      const page = simulatePage()

      // useFlag.ts: settled marks true synchronously in onMounted when
      // client() is undefined — variant never changes past its fallback,
      // but settled itself still resolves, which is the whole point.
      page.onWatcherFired({ settled: false, complete: true, activated: false })
      page.onWatcherFired({ settled: true, complete: true, activated: false })

      expect(page.attempts()).toHaveLength(1)
    })
  })
})
