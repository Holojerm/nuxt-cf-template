// One-click unsubscribe — the human-facing half. Someone clicked the
// "Unsubscribe" link in an email's footer, which is a plain `<a href>` and
// therefore always a GET.
//
// ── This GET does not unsubscribe anyone ─────────────────────────────────────
// It used to, and that was the same mistake the magic-link flow is built to
// avoid: this URL sits in inbound mail, and inbound mail is fetched by machines
// before a human ever sees it. Defender Safe Links, Proofpoint, and Mimecast
// GET every link in a message on delivery. A GET that wrote the opt-out meant a
// corporate mail gateway could unsubscribe someone from mail they had asked
// for, leaving nothing behind but a preference row nobody set.
//
// So this authenticates the token and redirects to a public confirmation page
// whose button POSTs (app/pages/unsubscribe.vue). The friction argument that
// justified writing on GET was about Gmail and Yahoo's bulk-sender rules — and
// those are satisfied by unsubscribe.post.ts, which is the endpoint their own
// one-click button actually calls. Nothing about that path gains a step.
//
// The old behaviour also landed people on /account, which is auth-gated: a
// signed-out clicker was bounced to /login having no idea whether it worked.
// The confirmation page needs no session.
//
// Public — no session exists on this request. Allowlisted by exact path in
// server/middleware/auth.ts, same shape as the /api/feedback entry next to it.

export default defineEventHandler(async (event) => {
  // IP-keyed like every other unauthenticated endpoint here. Worth naming the
  // one place this is imprecise: mail providers proxy the one-click POST
  // through their own infrastructure (see unsubscribe.post.ts), so many
  // different users unsubscribing through the same provider can share an IP.
  // The limit is generous for exactly that reason — this is abuse control
  // against a script hammering the endpoint, not a per-user quota. Its numbers
  // live in UNSUBSCRIBE_LIMITER, deliberately unmatchable by the native
  // binding so this surface stays on globally-counted KV — see the note there.
  await rateLimit(event, UNSUBSCRIBE_LIMITER)

  // Verified here rather than left to the POST so the page can say "this link
  // isn't valid" straight away instead of after a click. No write happens.
  const { userId, eventType, token } = await authenticateUnsubscribeRequest(event)

  // The parameters travel in the FRAGMENT, so the page's own request carries no
  // credential: fragments are never sent to a server, so the page view lands in
  // no access log and no `Referer`. The signed token was unavoidably in the
  // query of *this* request — RFC 8058 requires it there — but there is no
  // reason to repeat that on the next one.
  const params = new URLSearchParams({ u: userId, e: eventType, t: token })
  return sendRedirect(event, `/unsubscribe#${params.toString()}`)
})
