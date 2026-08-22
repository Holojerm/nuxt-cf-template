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
// They are queried out of the content collection below — which is also the only
// place in this sitemap where `<lastmod>` is a real per-URL date rather than the
// build date.
//
// Everything this route decides lives in `sitemapResponse()`, which is a pure
// function this repo can actually test. What is left here is config, one query,
// and two assignments — see that function for why the split is deliberate.

import { sitemapResponse } from '../utils/seo'
import { tryListBlogPosts } from '../utils/blog'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const appUrl = config.public.appUrl
  const indexable = config.public.indexable !== false

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')

  // Skip the query entirely when the document is going to be empty anyway — a
  // preview deploy should not be waking D1 to build a sitemap it suppresses.
  // A skipped query is not a failed one, hence `ok: true`.
  const { posts, ok } =
    indexable && appUrl ? await tryListBlogPosts(event) : { posts: [], ok: true }

  const { body, cacheControl } = sitemapResponse({
    appUrl,
    indexable,
    buildDate: config.buildDate,
    pages: config.publicPages ?? [],
    posts,
    complete: ok,
  })

  setResponseHeader(event, 'Cache-Control', cacheControl)
  return body
})
