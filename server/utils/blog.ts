// Reading the blog collection, server-side. One query shape, three callers:
// GET /api/blog, sitemap.xml, and llms.txt.
//
// ── Why the server owns every content query ──────────────────────────────────
// `queryCollection()` also exists as an app-side auto-import, and on the client
// it does something surprising: it downloads the collection's SQL dump and runs
// it through `@sqlite.org/sqlite-wasm` in the browser. For a documentation site
// with client-side search that is a good trade. Here it is two bad ones:
//
//   * A megabyte of WebAssembly plus the dump, on the first client-side
//     navigation, to read three blog posts.
//   * It would not run anyway. Compiling WebAssembly needs `'wasm-unsafe-eval'`
//     in `script-src`, and this app's CSP (nuxt.config.ts) does not grant it.
//     The failure appears only after a client-side navigation in production —
//     never in SSR, never in a unit test.
//
// So the pages call `useFetch('/api/blog…')` and the query stays here, where it
// runs in the Worker against D1 and ships JSON.
//
// The import is explicit rather than relying on the Nitro auto-import, for the
// reason CLAUDE.md › Gotchas records about `kv`: a server-util auto-import
// typechecks everywhere and is not always injected at runtime.

import type { H3Event } from 'h3'
import { queryCollection } from '@nuxt/content/nitro'

import { pathForLog } from './log'

/**
 * A post without its body — everything a list, a sitemap entry, or a JSON-LD
 * node needs, and nothing that costs a full parsed document to send.
 */
export interface BlogPostSummary {
  /** Route path, e.g. `/blog/how-billing-works`. Derived from the filename. */
  path: string
  title: string
  description: string
  /** `YYYY-MM-DD`, from frontmatter. */
  date: string
  /** `YYYY-MM-DD`, only when the post has actually been revised. */
  updated?: string
  author: string
}

/** Every post, newest first. */
export async function listBlogPosts(event: H3Event): Promise<BlogPostSummary[]> {
  const posts = await queryCollection(event, 'blog')
    .select('path', 'title', 'description', 'date', 'updated', 'author')
    .order('date', 'DESC')
    .all()

  // `updated` is nullable in SQLite and comes back as null, not undefined.
  return posts.map((post) => ({ ...post, updated: post.updated || undefined }))
}

/**
 * Every post, or none — never an exception.
 *
 * For the two crawler files. A sitemap missing its posts costs some crawl
 * coverage; a sitemap that throws costs all of it plus a crawl error in Search
 * Console, and the likely causes here are transient: D1 briefly unavailable, or
 * the very first request after a deploy racing content's own dump import. The
 * user-facing /api/blog routes deliberately do NOT use this — a reader asking
 * for the blog should see an error, not a convincing empty page.
 */
export async function listBlogPostsOrEmpty(event: H3Event): Promise<BlogPostSummary[]> {
  try {
    return await listBlogPosts(event)
  } catch (error) {
    console.warn(
      JSON.stringify({
        kind: 'blog_query_failed',
        path: pathForLog(event.path),
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}
