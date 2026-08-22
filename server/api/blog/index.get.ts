// GET /api/blog — every post, newest first, without bodies.
//
// Public: server/middleware/auth.ts allowlists GET on this prefix. The blog is
// the one part of the app that exists to be read by people who have never
// signed in — and by crawlers, which never will.
//
// It is an API route rather than an app-side `queryCollection()` call because
// content's client query path runs SQLite in WebAssembly in the browser; see
// server/utils/blog.ts for why that is both wasteful and blocked by our CSP.

import { listBlogPosts } from '../../utils/blog'

export default defineEventHandler(async (event) => {
  const posts = await listBlogPosts(event)

  // Five minutes, to browsers and to any shared cache that sees it (`max-age`
  // binds both; there is no `s-maxage` because there is no reason to split
  // them). Cloudflare's edge does not cache an /api/ path without a cache rule,
  // so in practice this is the reader's own browser. Short rather than long
  // because publishing a post should not mean waiting out a cache to see it.
  //
  // Unlike the crawler files, this route does NOT swallow a query failure —
  // it throws, so there is no degraded response to accidentally cache.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')

  return posts
})
