// Things that must be true of every log line this app writes.
//
// A leaf on purpose — no imports — so anything can pull it in, including the
// Nitro error plugin that runs before most of the app exists.

/**
 * A request path with the query string and fragment removed, for logging.
 *
 * ── Why a helper and not `event.path` ────────────────────────────────────────
 * Two routes in this app carry a live credential in their query string, because
 * the specs they implement require it: `/api/email/unsubscribe?t=<signed token>`
 * is RFC 8058's one-click URL, and a hand-assembled or legacy
 * `/auth/verify?token=…` still resolves. Logging `event.path` verbatim writes
 * those credentials to Cloudflare Logs — and, via the error plugin, into
 * PostHog's `$exception` events, where they are retained and widely readable.
 *
 * The nasty part is when it fires: a 5xx on one of those routes is exactly the
 * moment a request gets logged in full, and exactly the moment the token is
 * still unspent. So the one condition under which the credential is written
 * down is the one under which it is most likely to still work.
 *
 * A path with no query is still the whole diagnostic value of the field —
 * nobody debugs a 500 from a token — so there is nothing to trade off.
 *
 * Returns `undefined` for a missing path so callers can pass it straight
 * through to a JSON payload.
 */
export function pathForLog(path: string | undefined): string | undefined {
  if (!path) return undefined
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}
