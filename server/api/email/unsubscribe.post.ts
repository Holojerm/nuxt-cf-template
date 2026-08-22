// One-click unsubscribe — the machine-facing half (RFC 8058). Gmail and Yahoo
// both require List-Unsubscribe-Post for bulk senders: when it's present
// alongside List-Unsubscribe, the mail client renders its own "Unsubscribe"
// button next to the sender and POSTs `List-Unsubscribe=One-Click` here
// directly — no page load, no click-through, no session. That's what
// "one-click" means in the spec, and it's the version Gmail actually surfaces
// in its UI; the plain link in unsubscribe.get.ts is the fallback for clients
// that don't.
//
// Performs the identical write as the GET handler. The POST body itself
// (`List-Unsubscribe=One-Click`) carries no information this endpoint needs —
// everything required to identify the subscriber and event type is already
// in the URL from the List-Unsubscribe header, so there's nothing to read off
// the request beyond the query string.
//
// Public — no session exists on this request; it's the mail provider's own
// server making the call. Allowlisted by exact path in
// server/middleware/auth.ts.

export default defineEventHandler(async (event) => {
  // Same limit and same caveat as unsubscribe.get.ts: the caller here is
  // typically a mail provider's infrastructure, not the end user's browser,
  // so many opt-outs can legitimately share an IP.
  await rateLimit(event, { name: 'email-unsubscribe', limit: 30, windowSeconds: 60 })

  await resolveUnsubscribeRequest(event, db)

  // RFC 8058 doesn't prescribe a response body — the mail client doesn't
  // render one. 200 is the whole contract.
  setResponseStatus(event, 200)
  return { ok: true }
})
