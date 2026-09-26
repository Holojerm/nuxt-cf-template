// This product's own lifecycle steps — the fork owns this file.
//
// The template ships it empty and never edits it again. See lifecycle.ts for
// the contract (bounded windows, never rename an id) and lifecycle-steps.ts for
// worked examples.

import type { LifecycleStep } from './lifecycle'

export const APP_LIFECYCLE_STEPS: readonly LifecycleStep[] = []
