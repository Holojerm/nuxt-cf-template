// The first-run checklist's data — session required (no public route for it,
// unlike GET /api/billing/entitlement: there's nothing useful to show a
// signed-out visitor). Computes the four inputs with the fewest D1 reads
// (server/utils/onboarding.ts › computeOnboardingInputs) and derives the
// ordered steps (shared/utils/onboarding.ts, unit-tested on its own).
//
// Read-only, deliberately. This used to also record the one-time
// `user_activated` event when it observed `complete: true`, which sounded
// harmless — until it was pointed out that this handler runs once per page
// load, in the SAME tick as `useFlagVariant()` on the client, before that
// composable has ever resolved past its fallback (onMounted is the earliest
// point it can — app/composables/useFlag.ts). So the one call in an
// account's lifetime that actually tripped the idempotency guard always ran
// with the fallback variant, and the 'onboarding-layout' experiment had no
// real outcome data. See server/utils/onboarding.ts › recordActivationOnce
// and POST /api/onboarding/activated for where that write moved and why.
//
// `db` and `schema` are auto-imported by @nuxthub/core — never instantiate
// Drizzle manually.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const inputs = await computeOnboardingInputs(db, user.id, {
    portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
  })
  return deriveOnboardingSteps(inputs)
})
