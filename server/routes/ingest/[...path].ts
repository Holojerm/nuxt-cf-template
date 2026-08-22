// PostHog reverse proxy. The client SDK is configured with `api_host: '/ingest'`
// so every request — events, decide, session-replay snapshots, the SDK bundle
// itself — is fetched same-origin. This bypasses ad blockers and tracker
// blockers that drop direct calls to *.posthog.com.
//
//   /ingest/static/<path>   → https://us-assets.i.posthog.com/static/<path>
//   /ingest/<anything else> → https://us.i.posthog.com/<anything else>
//
// posthog-js issues GETs (decide, array.js) and POSTs (events, replay) so the
// proxy must preserve the method, headers, query string, and body. h3's
// `proxyRequest` handles all of that.

export default defineEventHandler(async (event) => {
  const path = (getRouterParam(event, 'path') ?? '').replace(/^\/+/, '')
  const search = getRequestURL(event).search

  const upstream = path.startsWith('static/')
    ? `https://us-assets.i.posthog.com/${path}${search}`
    : `https://us.i.posthog.com/${path}${search}`

  return proxyRequest(event, upstream, {
    headers: {
      // Don't leak our origin host upstream — let fetch use the upstream host.
      host: '',
      // Strip the query string and fragment off the Referer before it leaves.
      //
      // Because the proxy is same-origin, the browser sends a FULL-path Referer
      // on every analytics request — including the one fired from
      // /auth/verify?token=… while a live sign-in token is in the URL. That
      // header is a credential going to a third party in a field nobody thinks
      // to look at, and PostHog records it as `$referrer`. Sending only the
      // origin+path keeps whatever value the header has for debugging while
      // making it structurally incapable of carrying a secret.
      referer: refererWithoutQuery(getRequestHeader(event, 'referer')),
    },
    fetchOptions: { redirect: 'manual' },
  })
})

/**
 * Origin and path only. Returns `''` — which h3 reads as "drop this header" —
 * for a missing or unparseable value, because a Referer we cannot parse is one
 * we cannot promise is clean.
 */
function refererWithoutQuery(referer: string | undefined): string {
  if (!referer) return ''
  try {
    const url = new URL(referer)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}
