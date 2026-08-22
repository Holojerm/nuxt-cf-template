// GET /sitemap.xml
//
// The URL list is NOT maintained here. Static pages declare their own
// membership with `definePageMeta({ publicPage: … })`; the `pages:resolved`
// hook in nuxt.config.ts collects those at build time into
// `runtimeConfig.publicPages`, and this route renders whatever the route table
// actually contained.
//
// That indirection exists because the previous version of this file was a
// hand-kept array, and a hand-kept array is a second place to remember. Add
// /changelog, ship it, and it is simply never in the sitemap — nothing fails,
// nobody notices. Now the page that exists is the page that gets listed, and
// `scripts/check-seo.ts` fails the build if an indexable page forgets to
// declare itself.
//
// Blog posts are the other half, and they cannot work that way: `/blog/[slug]`
// is one route-table entry describing N URLs, so the hook skips it by design.
// They are queried out of the content collection below and appended — which is
// also the only place in this sitemap where `<lastmod>` is a real per-URL date
// rather than the build date.
//
// Still hand-rolled rather than @nuxtjs/sitemap: the whole thing is 50 lines,
// and a module would need configuring to exclude the gated pages anyway.

import { blogPostLastmod, buildSitemap, type SitemapEntry } from '../utils/seo'
import { listBlogPostsOrEmpty } from '../utils/blog'

/**
 * Crawl hints for a post. Lower than the marketing pages on purpose: an
 * individual post is worth indexing, but /pricing and the landing page are what
 * this site is for. `monthly` because a published post is normally finished —
 * the index at /blog is the URL that actually changes weekly, and it declares
 * that itself.
 *
 * These mirror the (inert) `publicPage` block on app/pages/blog/[slug].vue,
 * which exists to satisfy the SEO gate. This is the copy that ships.
 */
const POST_CRAWL_HINTS = { changefreq: 'monthly', priority: '0.5' } as const

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const appUrl = config.public.appUrl
  const indexable = config.public.indexable !== false

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  const staticEntries: SitemapEntry[] = (config.publicPages ?? []).map((page) => ({
    path: page.path,
    changefreq: page.changefreq,
    priority: page.priority,
    // Build date, not request date: `new Date()` here would tell crawlers every
    // page changed today, on every fetch, and they discount a lastmod that
    // always says "now". See runtimeConfig.buildDate in nuxt.config.ts.
    lastmod: config.buildDate,
  }))

  // Skip the query entirely when the document is going to be empty anyway — a
  // preview deploy should not be waking D1 to build a sitemap it suppresses.
  const posts = indexable && appUrl ? await listBlogPostsOrEmpty(event) : []
  const postEntries: SitemapEntry[] = posts.map((post) => ({
    path: post.path,
    ...POST_CRAWL_HINTS,
    lastmod: blogPostLastmod(post),
  }))

  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return buildSitemap({ appUrl, indexable, entries: [...staticEntries, ...postEntries] })
})
