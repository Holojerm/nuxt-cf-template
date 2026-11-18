// GET /offline
//
// What the service worker shows when a navigation finds no network. A route,
// not a page: see ../utils/offline-page.ts.
import { BRAND_OG_COLORS } from '#shared/utils/brand-colors.generated'

import { buildOfflinePage } from '../utils/offline-page'

export default defineEventHandler((event) => {
  const { pwa, appName } = useRuntimeConfig().public
  if (!pwa.enabled) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  // The worker's copy is the only one that should outlive the request.
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex')
  return buildOfflinePage({
    appName,
    title: pwa.offlineTitle,
    body: pwa.offlineBody,
    retry: pwa.offlineRetry,
    colors: BRAND_OG_COLORS,
  })
})
