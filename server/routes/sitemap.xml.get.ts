// GET /sitemap.xml
//
// Hand-rolled instead of pulling in @nuxtjs/sitemap: this template's public
// surface is a handful of marketing pages, and a module that crawls the route
// table would need configuring to exclude the gated ones anyway. When your app
// grows dynamic public pages (blog posts, public profiles), replace the static
// list below with a D1 query — or install the module then, with a real reason.
//
// Only genuinely public, indexable pages belong here. Listing /account or
// /dashboard would just feed crawlers a stream of redirects to /login.

interface SitemapEntry {
  path: string
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  priority: string
}

const PUBLIC_PAGES: SitemapEntry[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
]

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  const appUrl = (config.public.appUrl || '').replace(/\/+$/, '')

  if (!appUrl || config.public.indexable === false) {
    // No canonical origin means every URL in the file would be relative and
    // therefore invalid. An empty (but well-formed) sitemap beats a broken one.
    setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
  }

  const lastmod = new Date().toISOString().slice(0, 10)
  const urls = PUBLIC_PAGES.map(
    (page) =>
      `  <url>\n    <loc>${appUrl}${page.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`,
  ).join('\n')

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
})
