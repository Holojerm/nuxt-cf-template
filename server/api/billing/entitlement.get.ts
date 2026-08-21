// The signed-in user's entitlement status — feeds the client-side subscription
// gate (app/middleware/subscription.ts), the pricing page, and /account.
// Auth-only on purpose: unsubscribed users must be able to ask "am I
// subscribed?".
//
// The shape lives in server/utils/entitlement-view.ts rather than here, because
// the admin console's read-only "view as" has to return the identical thing for
// a different user. Two hand-maintained copies of "what the customer sees" is
// how a support tool starts lying.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  return buildEntitlementView(db, user.id, {
    portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
  })
})
