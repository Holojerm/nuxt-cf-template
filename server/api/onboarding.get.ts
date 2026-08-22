// The first-run checklist's data — session required (no public route for it,
// unlike GET /api/billing/entitlement: there's nothing useful to show a
// signed-out visitor). Computes the four inputs with the fewest D1 reads
// (server/utils/onboarding.ts › computeOnboardingInputs), derives the
// ordered steps (shared/utils/onboarding.ts, unit-tested on its own), and —
// the moment it first observes every step done — fires the one
// `user_activated` event this app cares about. See
// server/utils/onboarding.ts › recordActivationOnce for why that happens
// here, server-side, and how it stays idempotent across repeat calls.
//
// `db` and `schema` are auto-imported by @nuxthub/core — never instantiate
// Drizzle manually.

import { z } from 'zod'

// Only ever labels an analytics property on `user_activated` — it never
// branches this handler's own logic, so a missing or malformed value
// degrades to 'control' rather than 400ing a page load. Deliberately a
// bounded string rather than a strict enum: flags (and their variants) are
// created in the PostHog dashboard, not in code (app/composables/useFlag.ts),
// so a new variant name shouldn't require a matching code change here.
const querySchema = z.object({
  variant: z.string().trim().min(1).max(40).catch('control'),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const { variant } = await getValidatedQuery(event, querySchema.parse)

  const inputs = await computeOnboardingInputs(db, user.id, {
    portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
  })
  const progress = deriveOnboardingSteps(inputs)

  if (progress.complete) {
    await recordActivationOnce(db, user.id, variant)
  }

  return progress
})
