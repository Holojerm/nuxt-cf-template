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
// runs in the Worker against D1 and ships JSON. Measured: with no app-side
// call, no sqlite wasm reaches `.output/public/_nuxt` at all.
//
// The import is explicit rather than relying on the Nitro auto-import, for the
// reason CLAUDE.md › Gotchas records about `kv`: a server-util auto-import
// typechecks everywhere and is not always injected at runtime.

import type { H3Event } from 'h3'
import { queryCollection } from '@nuxt/content/nitro'

import type { BlogPostSummary } from '#shared/utils/blog'
import { pathForLog } from './log'

// Not re-exported: `shared/` is auto-imported Nitro-wide, so a second export of
// the same name gives Nuxt two sources for one identifier and it warns about
// the ambiguity on every build. Import it from '#shared/utils/blog'.

/** Newest first, drafts excluded. Throws if the collection cannot be read. */
export async function listBlogPosts(event: H3Event): Promise<BlogPostSummary[]> {
  const posts = await queryCollection(event, 'blog')
    .select('path', 'title', 'description', 'date', 'updated', 'author')
    // Filtered in SQL rather than after the fact: a draft should not travel to
    // the caller at all. `draft` has a schema default of `false`, so the column
    // is never NULL and this comparison never has to reason about three-valued
    // logic — see content.config.ts.
    .where('draft', '=', false)
    .order('date', 'DESC')
    .all()

  // `updated` is nullable in SQLite and comes back as null, not undefined.
  return posts.map((post) => ({ ...post, updated: post.updated || undefined }))
}

/**
 * What the two crawler files get: the posts, plus whether that list is
 * trustworthy.
 *
 * `ok: false` is not a detail the caller may ignore. Serving a degraded
 * sitemap is right — a sitemap that 500s costs all crawl coverage plus an error
 * in Search Console, and the likely causes here are transient (D1 briefly
 * unavailable, or the first request after a deploy racing content's own dump
 * import). Serving it with the usual one-hour cache is NOT right: "every post
 * is gone" and "every post was deleted" look identical to a crawler, and an
 * hour is long enough for that to be believed. So the flag exists to force the
 * caller to pick a Cache-Control — see `crawlerCacheControl()`.
 *
 * The user-facing /api/blog routes deliberately do not use this. A reader
 * asking for the blog should get an error, not a convincing empty page.
 */
export async function tryListBlogPosts(
  event: H3Event,
): Promise<{ posts: BlogPostSummary[]; ok: boolean }> {
  try {
    return { posts: await listBlogPosts(event), ok: true }
  } catch (error) {
    console.warn(
      JSON.stringify({
        kind: 'blog_query_failed',
        path: pathForLog(event.path),
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return { posts: [], ok: false }
  }
}
