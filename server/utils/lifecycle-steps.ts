// The steps built from lifecycle-sequence.ts, which is where their wording,
// delay and audience live. Features add theirs with registerLifecycleStep()
// (billing's `pass_expiring`), and a step that needs its own query goes in
// lifecycle-app-steps.ts; the task runs these, then those.

import { defineLifecycleStep, isImmediate } from './lifecycle-definitions'
import { LIFECYCLE_SEQUENCE } from './lifecycle-sequence'
import type { LifecycleStep } from './lifecycle'

const enabled = LIFECYCLE_SEQUENCE.filter((definition) => definition.enabled !== false)

export const TEMPLATE_LIFECYCLE_STEPS: readonly LifecycleStep[] = enabled.map(defineLifecycleStep)

/**
 * Steps due the moment an account exists (the welcome). Sign-up sends them at
 * once (server/utils/lifecycle-runtime.ts); the daily run is the retry.
 */
export const IMMEDIATE_LIFECYCLE_STEPS: readonly LifecycleStep[] = enabled
  .filter(isImmediate)
  .map(defineLifecycleStep)
