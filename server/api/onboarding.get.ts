// The first-run checklist's data — session required (no public route for it,
// unlike GET /api/billing/entitlement: there's nothing useful to show a
// signed-out visitor). Computes the four checklist signals with the fewest
// D1 reads (server/utils/onboarding.ts › computeOnboardingInputs), derives
// the ordered steps (shared/utils/onboarding.ts, unit-tested on its own),
// and reports whether this account has already been recorded as activated
// (server/utils/onboarding.ts › hasActivated) — one more indexed read,
// alongside the other four in the same Promise.all, so the client can skip
// POST /api/onboarding/activated entirely once it's true (see
// app/pages/dashboard.vue) instead of calling an endpoint whose only job at
// that point is to say no.
//
// Read-only, deliberately. This used to also RECORD the one-time
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

  const [inputs, activated] = await Promise.all([
    computeOnboardingInputs(db, user.id, {
      portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
    }),
    hasActivated(db, user.id),
  ])

  return onboardingStatusSchema.parse({ ...deriveOnboardingSteps(inputs), activated })
})
