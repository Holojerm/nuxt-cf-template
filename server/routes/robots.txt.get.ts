// GET /robots.txt
//
// Generated rather than dropped in public/ so it can reference the real
// deployment URL for the sitemap line, and so preview deploys can tell crawlers
// to stay away without a second static file to keep in sync.
//
// The body — including the named AI-crawler policy — is built by
// buildRobotsTxt() in server/utils/seo.ts, which is unit-tested.

import { buildRobotsTxt } from '../utils/seo'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  const body = buildRobotsTxt({
    appUrl: config.public.appUrl,
    indexable: config.public.indexable !== false,
    allowAiCrawlers: config.public.allowAiCrawlers !== false,
  })

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return body
})
