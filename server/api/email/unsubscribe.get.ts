// One-click unsubscribe — the human-facing half. Someone clicked the
// "Unsubscribe" link in an email's footer, which is a plain `<a href>` and
// therefore always a GET. RFC 8058's List-Unsubscribe-Post is what mail
// clients use instead of a click-through (see unsubscribe.post.ts) — this
// file exists for the rest of the world: anyone reading the email in a
// client that doesn't surface the one-click button, or just clicking the
// link in the footer text directly.
//
// Performs the opt-out immediately and redirects, rather than rendering a
// confirmation page with a second "yes, really unsubscribe" button — an extra
// click is exactly the friction this feature exists to remove under Gmail
// and Yahoo's bulk-sender rules, and getting it wrong here is a spam
// complaint, not a support ticket. Landing on /account afterwards (rather
// than a bare 200) means a signed-in visitor sees it took effect and can turn
// it back on from the same screen if they clicked by mistake.
//
// Public — no session exists on this request. Allowlisted by exact path in
// server/middleware/auth.ts, same shape as the /api/feedback entry next to
// it.

export default defineEventHandler(async (event) => {
  // IP-keyed like every other unauthenticated endpoint here. Worth naming the
  // one place this is imprecise: mail providers proxy the one-click POST
  // through their own infrastructure (see unsubscribe.post.ts), so many
  // different users unsubscribing through the same provider can share an IP.
  // The limit is generous for exactly that reason — this is abuse control
  // against a script hammering the endpoint, not a per-user quota.
  await rateLimit(event, { name: 'email-unsubscribe', limit: 30, windowSeconds: 60 })

  const { eventType } = await resolveUnsubscribeRequest(event, db)

  return sendRedirect(event, `/account?unsubscribed=${encodeURIComponent(eventType)}`)
})
