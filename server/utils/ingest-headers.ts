// Header allowlist for server/routes/ingest/[...path].ts, split out so it can
// be unit tested without going through a real H3 event.
//
// h3's `proxyRequest` builds upstream headers from `getProxyRequestHeaders`,
// which copies every incoming header except an eight-entry ignore list
// (transfer-encoding, accept-encoding, connection, keep-alive, upgrade,
// expect, host, accept) — notably NOT `cookie` or `authorization`. Because the
// PostHog SDK is pointed at this same-origin proxy, the browser attaches this
// app's sealed session cookie to every analytics request, and a
// copy-everything proxy would ship it straight to PostHog — a bearer
// credential sitting in a third party's request logs. So the route never uses
// `proxyRequest`'s default; it builds the upstream headers from the explicit
// allowlist below instead, which means the next header PostHog would like is
// one someone has to add here on purpose.

/** Every header the /ingest proxy is allowed to forward upstream. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'content-length',
  'user-agent',
  'accept-language',
] as const

/**
 * Build the header set to send to PostHog from the incoming request's
 * headers. Anything not named in `FORWARDED_REQUEST_HEADERS` — most
 * importantly `cookie` and `authorization` — never reaches the output, no
 * matter what the incoming request carried.
 *
 * `forwardClientIp` adds a single `x-forwarded-for` carrying the visitor's
 * address, which is what PostHog reads for GeoIP. Off, PostHog sees only the
 * Worker's own address; an app that strips GeoIP on purpose leaves it off (see
 * `configureIngestRelay` in server/utils/ingest-relay.ts).
 */
export function forwardedIngestHeaders(
  incoming: Record<string, string | undefined>,
  options: { forwardClientIp?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming[name]
    if (value !== undefined) headers[name] = value
  }
  if (options.forwardClientIp) {
    const clientIp = clientIpOf(incoming)
    if (clientIp) headers['x-forwarded-for'] = clientIp
  }
  const referer = refererWithoutQuery(incoming.referer)
  if (referer !== undefined) headers.referer = referer
  return headers
}

/**
 * The visitor's address for PostHog's GeoIP, as ONE value. `cf-connecting-ip`
 * is set by the edge and cannot be spoofed by the client, so it wins; a
 * client-supplied `x-forwarded-for` chain is only the local-dev fallback, and
 * only its first entry is used.
 */
function clientIpOf(incoming: Record<string, string | undefined>): string | undefined {
  return (
    incoming['cf-connecting-ip'] || incoming['x-forwarded-for']?.split(',')[0]?.trim() || undefined
  )
}

/**
 * Origin and path only, or `undefined` — meaning "omit the header entirely" —
 * for a missing or unparseable Referer.
 *
 * `undefined` is safe here specifically because `forwardedIngestHeaders`
 * builds its output from nothing rather than merging over the incoming
 * headers: there is no pre-existing `referer` entry for a skipped key to fall
 * back to, so an unparseable Referer is simply never added to the outgoing
 * request — not preserved unmodified. (That distinction is the whole bug this
 * function used to have: h3's `mergeHeaders` only overwrites keys whose value
 * is not `undefined`, so returning `undefined` into a merge over
 * `getProxyRequestHeaders(event)` — which already contains the incoming
 * Referer — left the original, full-query header in place. Building the
 * header set from scratch, as `forwardedIngestHeaders` does, is what makes
 * `undefined` mean "drop" rather than "keep".)
 */
export function refererWithoutQuery(referer: string | undefined): string | undefined {
  if (!referer) return undefined
  try {
    const url = new URL(referer)
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}
