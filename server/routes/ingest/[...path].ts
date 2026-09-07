// PostHog reverse proxy. The client SDK is configured with `api_host: '/ingest'`
// so every request — events, decide, session-replay snapshots, the SDK bundle
// itself — is fetched same-origin. This bypasses ad blockers and tracker
// blockers that drop direct calls to *.posthog.com.
//
//   /ingest/static/<path>   → https://us-assets.i.posthog.com/static/<path>
//   /ingest/<anything else> → https://us.i.posthog.com/<anything else>
//
// posthog-js issues GETs (decide, array.js) and POSTs (events, replay) so the
// proxy must preserve the method, query string, and body. It must NOT preserve
// every header: because the proxy is same-origin, the browser attaches the
// sealed `nuxt-session` cookie to every analytics request, and h3's
// `proxyRequest` forwards `Cookie` verbatim — its ignore-list stops at
// hop-by-hop headers. That is the bearer credential for the account, sent to a
// third party on every page view. So the header set is built here, with the
// two headers that can carry a credential removed or reduced, and handed to
// `sendProxy` rather than merged over `proxyRequest`'s own copy of the request.

const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])

export default defineEventHandler(async (event) => {
  const path = (getRouterParam(event, 'path') ?? '').replace(/^\/+/, '')
  const search = getRequestURL(event).search

  const upstream = path.startsWith('static/')
    ? `https://us-assets.i.posthog.com/${path}${search}`
    : `https://us.i.posthog.com/${path}${search}`

  // `host` false: the upstream URL is absolute, so fetch sets its own Host.
  const headers = new Headers(getProxyRequestHeaders(event, { host: false }))
  headers.delete('cookie')

  // Strip the query string and fragment off the Referer before it leaves.
  //
  // The browser sends a FULL-path Referer on every analytics request —
  // including the one fired from /auth/verify?token=… while a live sign-in
  // token is in the URL — and PostHog records it as `$referrer`. Sending only
  // the origin+path keeps whatever value the header has for debugging while
  // making it structurally incapable of carrying a secret. A Referer we cannot
  // parse is one we cannot promise is clean, so it is dropped outright.
  const referer = refererWithoutQuery(getRequestHeader(event, 'referer'))
  if (referer) headers.set('referer', referer)
  else headers.delete('referer')

  const method = event.method
  // `readRawBody` hands back a Node Buffer, which the Workers `fetch` type does
  // not accept as a body; a Uint8Array view over the same bytes is.
  const raw = PAYLOAD_METHODS.has(method)
    ? await readRawBody(event, false).catch(() => undefined)
    : undefined
  const body = raw ? new Uint8Array(raw) : undefined

  return sendProxy(event, upstream, {
    fetchOptions: { method, body, headers, redirect: 'manual' },
  })
})

/** Origin and path only; `undefined` for a missing or unparseable value. */
function refererWithoutQuery(referer: string | undefined): string | undefined {
  if (!referer) return undefined
  try {
    const url = new URL(referer)
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}
