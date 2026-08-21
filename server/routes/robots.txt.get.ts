// GET /robots.txt
//
// Generated rather than dropped in public/ so it can reference the real
// deployment URL for the sitemap line, and so preview deploys can tell crawlers
// to stay away without a second static file to keep in sync.
//
// Disallow list: everything that is either private (the account area, the API)
// or has no standalone value in an index (OAuth callbacks, the PostHog proxy).

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  const appUrl = (config.public.appUrl || '').replace(/\/+$/, '')

  // A preview build has no business in a search index — and worse, an indexed
  // preview URL competes with production for the same content.
  const indexable = config.public.indexable !== false && Boolean(appUrl)

  const body = indexable
    ? [
        'User-agent: *',
        'Allow: /',
        'Disallow: /account',
        'Disallow: /dashboard',
        'Disallow: /api/',
        'Disallow: /ingest/',
        '',
        `Sitemap: ${appUrl}/sitemap.xml`,
        '',
      ].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n')

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return body
})
