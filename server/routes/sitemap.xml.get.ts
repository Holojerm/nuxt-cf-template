// GET /sitemap.xml
//
// The URL list is NOT maintained here. Pages declare their own membership with
// `definePageMeta({ publicPage: … })`; the `pages:extend` hook in
// nuxt.config.ts collects those at build time into `runtimeConfig.publicPages`,
// and this route renders whatever the route table actually contained.
//
// That indirection exists because the previous version of this file was a
// hand-kept array, and a hand-kept array is a second place to remember. Add
// /changelog, ship it, and it is simply never in the sitemap — nothing fails,
// nobody notices. Now the page that exists is the page that gets listed, and
// `scripts/check-seo.ts` fails the build if an indexable page forgets to
// declare itself.
//
// Dynamic public pages (blog posts, public profiles) have no route-table entry
// to collect — a route like /posts/[id] is one pattern, not N URLs. Query D1
// for those and concatenate them onto `entries` below.
//
// Still hand-rolled rather than @nuxtjs/sitemap: the whole thing is 40 lines,
// and a module would need configuring to exclude the gated pages anyway.

import { absoluteUrl, escapeXml } from '#shared/utils/site'

const EMPTY_SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  const appUrl = config.public.appUrl

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  if (!appUrl || config.public.indexable === false) {
    // No canonical origin means every <loc> would be relative and therefore
    // invalid. An empty but well-formed sitemap beats a broken one.
    return EMPTY_SITEMAP
  }

  const entries = config.publicPages ?? []
  if (entries.length === 0) return EMPTY_SITEMAP

  // Build date, not request date: `new Date()` here would tell crawlers every
  // page changed today, on every fetch, and they discount a lastmod that always
  // says "now". See runtimeConfig.buildDate in nuxt.config.ts.
  const lastmod = config.buildDate

  const urls = entries
    .map((entry) => {
      const loc = escapeXml(absoluteUrl(appUrl, entry.path))
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`
    })
    .join('\n')

  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
})
