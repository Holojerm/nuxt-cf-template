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
    // Don't leak our origin host upstream — let fetch use the upstream host.
    headers: { host: '' },
    fetchOptions: { redirect: 'manual' },
  })
})
