// GET /sw.js
//
// A route, not a file in public/, because the script carries this deploy's
// build id, `app.baseURL` and the routes the app wants offline, and because
// switching the layer off has to turn the URL into a 404. At the root so its
// scope is the whole app.
import { withBase } from '#server/utils/manifest'

import { pwaPrefixes } from '../../shared/utils/pwa-cache'
import { renderServiceWorker } from '../utils/service-worker'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  if (!config.public.pwa.enabled) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const { baseURL, buildAssetsDir, cdnURL } = config.app
  const based = (paths: string[]) => paths.map((path) => withBase(baseURL, path))

  setResponseHeader(event, 'Content-Type', 'text/javascript; charset=utf-8')
  // Browsers skip the HTTP cache for a worker script by default; this covers the rest.
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  return renderServiceWorker({
    version: config.app.buildId,
    offlineUrl: withBase(baseURL, '/offline'),
    appName: config.public.appName,
    homeUrl: baseURL,
    iconUrl: withBase(baseURL, '/icon-192.png'),
    offlineRoutes: based(pwaPrefixes(config.public.pwa.offlineRoutes)),
    offlineApi: based(pwaPrefixes(config.public.pwa.offlineApi)),
    // Behind a CDN the build's files are another origin's, and the worker
    // keeps only its own.
    assetPrefixes: cdnURL ? [] : based([buildAssetsDir]),
    // `nuxt dev` serves modules under unhashed names, and far more of them.
    assetsHashed: !import.meta.dev,
    cacheLimits: { pages: 30, data: 100, assets: import.meta.dev ? 5000 : 400 },
  })
})
