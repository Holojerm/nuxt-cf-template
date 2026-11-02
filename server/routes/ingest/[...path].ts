import { getRequestHeaders, readRawBody, sendProxy } from 'h3'

import { forwardedIngestHeaders } from '../../utils/ingest-headers'
import { getForwardClientIp, getIngestLimiter } from '../../utils/ingest-relay'

// PostHog reverse proxy. The client SDK is configured with `api_host: '/ingest'`
// so every request — events, decide, session-replay snapshots, the SDK bundle
// itself — is fetched same-origin. This bypasses ad blockers and tracker
// blockers that drop direct calls to *.posthog.com.
//
//   /ingest/static/<path>   → https://us-assets.i.posthog.com/static/<path>
//   /ingest/<anything else> → https://us.i.posthog.com/<anything else>
//
// posthog-js issues GETs (decide, array.js) and POSTs (events, replay) so the
// proxy must preserve the method, query string, and body — but NOT the
// headers wholesale. See server/utils/ingest-headers.ts for why: h3's
// `proxyRequest` forwards every incoming header except an eight-entry ignore
// list that does not include `cookie` or `authorization`, which would ship
// the sealed session cookie to PostHog on every request. This route calls
// `sendProxy` directly instead, with headers built from an explicit
// allowlist. That helper also drops the query string and fragment off the
// Referer, so a sign-in token in the URL cannot ride along as `$referrer`.
const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])

export default defineEventHandler(async (event) => {
  // An open proxy with no counter is an open proxy anyone can point anything
  // through, on our bill and from our IP reputation. Opt-in, for the KV cost. server/middleware/auth.ts
  // never sees this route — it only guards `/api/**` — so the limit lives here.
  // Budget and its reasoning: server/utils/ingest-relay.ts.
  //
  // Keyed by a salted hash rather than the raw address: this is the busiest
  // anonymous surface in the app, and its counters would otherwise be a rolling
  // list of visitor IPs sitting in KV. Fails open, like every limiter here — a
  // broken KV must not silently switch analytics off.
  const limiter = getIngestLimiter()
  if (limiter) await rateLimit(event, { ...limiter, identifier: await hashedClientIp(event) })

  const path = (getRouterParam(event, 'path') ?? '').replace(/^\/+/, '')
  const search = getRequestURL(event).search

  const upstream = path.startsWith('static/')
    ? `https://us-assets.i.posthog.com/${path}${search}`
    : `https://us.i.posthog.com/${path}${search}`

  const headers = forwardedIngestHeaders(getRequestHeaders(event), {
    forwardClientIp: getForwardClientIp(),
  })

  // `false` asks h3 for the raw Buffer rather than a decoded string, so a
  // binary or compressed body (session-replay snapshots in particular) is
  // forwarded byte-for-byte. `fetch`'s BodyInit type doesn't know about
  // Node's `Buffer`, though it satisfies `ArrayBufferView` at runtime — wrap
  // it as a plain `Uint8Array` to give TypeScript what it's actually asking
  // for without lying about the type.
  const rawBody = PAYLOAD_METHODS.has(event.method)
    ? await readRawBody(event, false).catch(() => undefined)
    : undefined
  const body = rawBody ? new Uint8Array(rawBody) : undefined

  return sendProxy(event, upstream, {
    headers,
    fetchOptions: {
      method: event.method,
      body,
      redirect: 'manual',
    },
  })
})
