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

  // Content is immutable between deploys, so a short shared cache is free.
  // Short rather than long because publishing a post should not mean waiting
  // out a cache to see it.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')

  return posts
})
