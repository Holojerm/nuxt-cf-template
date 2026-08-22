// Read-only "view as" — what this customer's app would tell them right now.
// Admin-only, GET-only, and audited on every call.
//
// ── Why this, and not session impersonation ──────────────────────────────────
// The obvious build is "become the user": swap the admin's session for theirs,
// browse the real app, hand the session back. It reproduces bugs perfectly. It
// is also the wrong shape, for reasons that are structural rather than a matter
// of care:
//
//   - Read-only would have to be *enforced*, everywhere, forever. Every non-GET
//     handler in the app — today's and every one a fork adds — would need to
//     consult an "am I impersonating" flag and refuse. One handler that forgets
//     is an admin silently writing to a customer's account under the customer's
//     own identity, and the audit trail records the customer as the actor. The
//     failure is invisible in exactly the way this whole feature exists to
//     prevent.
//   - It is a privilege-escalation primitive by construction. A bug anywhere in
//     the flow that starts it — a missing requireAdmin, a replayable link, a
//     forged parameter — mints a valid session for an arbitrary account. There
//     is no such bug available here, because no session is ever created.
//   - It teaches the wrong reflex. Once "become the user" exists, it becomes
//     the way support does everything, including things they should be doing
//     through an audited endpoint that names the action.
//
// What support actually needs from impersonation is almost never "click around
// as them" — it is "what does their state resolve to, and which gates would let
// them through". That is a computation, and a computation can just be returned:
// the same functions the customer's own requests run, run for their user id,
// rendered to an admin under a banner that says whose data it is.
//
// So there is no session, no cookie, no token, and nothing the browser carries
// away. The admin is authenticated as themselves for every byte of this. The
// worst case is an admin reading data they were already authorised to read on
// the detail page next door — and the audit row says they did.
//
// If a fork genuinely needs to drive the real UI as a customer, the honest
// upgrade is a signed, short-lived, single-user read token that a server
// middleware rejects on every non-GET request, started and stopped with its own
// audit rows. Build that when a bug actually demands it; do not start there.
//
// ── Read-only is structural, not enforced ────────────────────────────────────
// The `.get.ts` suffix is the whole mechanism: Nitro registers this path for
// GET only, so there is no write handler to reach. Measured on Nitro 2.13.4 /
// h3 v1, POST, PUT, PATCH, and DELETE to this path all return **404** (the
// router finds no route for that method), not 405. Either way nothing here
// writes — but the number is worth stating correctly, because "405" is the
// intuitive guess and this repo's own notes had it wrong. If a future h3 starts
// answering 405 preemptively, that is a nicer answer to the same question and
// changes nothing about the design.

import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing user id' })

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, id),
    columns: { id: true, email: true, name: true },
  })
  if (!user) throw createError({ statusCode: 404, message: 'User not found' })

  return withAudit(
    db,
    {
      actorUserId: admin.id,
      action: 'admin.user_viewed_as',
      targetType: 'user',
      targetId: user.id,
      // No email in metadata — see server/utils/audit.ts.
      ipHash: await auditIpHash(event),
    },
    async () => {
      // The identical function GET /api/billing/entitlement runs for the
      // customer — see server/utils/entitlement-view.ts for why it is shared.
      const entitlement = await buildEntitlementView(db, user.id, {
        portalConfigured: Boolean(useRuntimeConfig(event).paddle.apiKey),
      })

      return {
        /** Never omitted, never false. The UI banners the whole panel on it. */
        readOnly: true as const,
        user: { id: user.id, email: user.email, name: user.name },
        entitlement,
        // The two client-side gates, resolved. This is the "why can't I get in"
        // answer: `auth` passes for anyone with an account, `subscription`
        // passes only with a granting entitlement — the same condition
        // app/middleware/subscription.ts checks against this exact payload.
        gates: {
          auth: true,
          subscription: entitlement.active,
        },
        /** Where those gates would land them if they opened /dashboard now. */
        dashboardReachable: entitlement.active,
      }
    },
  )
})
