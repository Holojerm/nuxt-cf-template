// GET /sw.js
//
// A route, not a file in public/, because the script carries this deploy's
// build id and `app.baseURL`, and because switching the layer off has to turn
// the URL into a 404. At the root so its scope is the whole app.
import { withBase } from '#server/utils/manifest'

import { renderServiceWorker } from '../utils/service-worker'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  if (!config.public.pwa.enabled) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Content-Type', 'text/javascript; charset=utf-8')
  // Browsers skip the HTTP cache for a worker script by default; this covers the rest.
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  return renderServiceWorker({
    version: config.app.buildId,
    offlineUrl: withBase(config.app.baseURL, '/offline'),
    appName: config.public.appName,
    homeUrl: config.app.baseURL,
    iconUrl: withBase(config.app.baseURL, '/icon-192.png'),
  })
})
