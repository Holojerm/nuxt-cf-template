// Records the one-time `user_activated` event for the first-run checklist —
// the write half of GET /api/onboarding's read. Split into its own endpoint
// (rather than the GET handler firing it when it saw `complete: true`)
// because that GET runs once per page load, often during the same tick as
// `useFlagVariant()` on the client — before that composable has resolved
// past its fallback (app/composables/useFlag.ts). Recording activation
// there meant the one call that ever actually fired the event, per account,
// was almost always tagged with the fallback variant rather than the one
// the visitor was really shown. This endpoint is the client's explicit "I
// just watched the checklist reach complete, with this variant on screen"
// signal — see app/pages/dashboard.vue for when it's called.
//
// `db` and `schema` are auto-imported by @nuxthub/core — never instantiate
// Drizzle manually.

import { z } from 'zod'

const bodySchema = z.object({
  // Bounded to ONBOARDING_LAYOUT_VARIANTS (shared/utils/onboarding.ts) —
  // the known arms of the 'onboarding-layout' flag — rather than an open
  // string. Still client-asserted: the browser is what resolved the
  // PostHog flag, and this handler has no independent way to check which
  // arm a given visitor was actually shown. Bounding it only rules out
  // arbitrary text riding along on the audit row and the analytics event,
  // not a mistaken value from a legitimate client.
  variant: onboardingLayoutVariantSchema,
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const { variant } = await readValidatedBody(event, bodySchema.parse)

  // activateIfComplete recomputes the checklist itself rather than trusting
  // that this request only arrives when it's actually done — see
  // server/utils/onboarding.ts for why.
  return activateIfComplete(db, user.id, variant, {
    portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
  })
})
