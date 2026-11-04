// One-click unsubscribe — the human-facing half: the footer link, a plain GET.
//
// This GET does not unsubscribe anyone. The URL sits in inbound mail, which
// gateways (Safe Links, Proofpoint, Mimecast) GET on delivery, so a writing GET
// let a mail gateway opt people out of mail they asked for. It authenticates the
// token and redirects to a public confirmation page whose button POSTs
// (app/pages/unsubscribe.vue). Gmail/Yahoo's one-click rules are met by
// unsubscribe.post.ts, which their button calls; it gains no step. The page needs
// no session (the old /account landing bounced signed-out clickers to /login).
//
// Public: allowlisted by exact path in server/middleware/auth.ts.

export default defineEventHandler(async (event) => {
  // IP-keyed, which is imprecise here: mail providers proxy the one-click POST,
  // so many users can share an IP. Hence generous: abuse control, not a quota.
  // UNSUBSCRIBE_LIMITER is deliberately unmatchable by the native binding (see
  // rate-limit.ts).
  await rateLimit(event, UNSUBSCRIBE_LIMITER)

  // Verified here so the page can say "invalid link" before a click. No write.
  const { userId, eventType, token } = await authenticateUnsubscribeRequest(event)

  // Parameters travel in the FRAGMENT, which is never sent to a server: no access
  // log or `Referer` carries the credential (RFC 8058 forced the query on THIS request).
  const params = new URLSearchParams({ u: userId, e: eventType, t: token })
  return sendRedirect(event, `/unsubscribe#${params.toString()}`)
})
