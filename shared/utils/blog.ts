// The blog's shape and its one visibility rule, as pure data and pure
// functions.
//
// Lives in `shared/` rather than next to the query in server/utils/blog.ts for
// the same reason shared/utils/site.ts does: that module imports
// @nuxt/content's Nitro entry, which resolves a `#content/*` build alias that
// does not exist inside the workerd vitest pool. Anything with a rule in it
// belongs somewhere a test can reach.

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
  /** Unfinished. See `isPostVisible()` for exactly what that means. */
  draft?: boolean
}

/**
 * Whether a post may be served at its own URL.
 *
 * A draft is **never listed** — not on /blog, not in sitemap.xml, not in
 * llms.txt; those three filter it out in the query itself. This function covers
 * the remaining case: typing the URL directly.
 *
 * In dev that works, because a draft you cannot open is a draft you cannot
 * proofread, and "flip the flag, look, flip it back" is a workflow that ends
 * with someone publishing by accident. In production it is a 404 — not a 403,
 * and not a rendered page behind a guessable URL, because an unfinished post
 * shared by a stranger is the failure this flag exists to prevent.
 */
export function isPostVisible(post: { draft?: boolean }, isDev: boolean): boolean {
  return !post.draft || isDev
}

/** A post list, and whether it can be believed. */
export interface BlogQueryResult {
  posts: BlogPostSummary[]
  /**
   * False when the load failed. Callers must not cache a `false` result, and
   * must not serve it with a cacheable Cache-Control — see
   * `crawlerCacheControl()` in server/utils/seo.ts.
   */
  ok: boolean
}

/**
 * Run a post load, turning a failure into an explicitly-incomplete result.
 *
 * Takes the loader as an argument rather than calling the collection itself,
 * for two reasons. It keeps this rule testable — server/utils/blog.ts imports
 * @nuxt/content's Nitro entry, which resolves a build-only alias the workerd
 * pool cannot follow. And it puts the caching decision on the *outside* of the
 * thing that throws: the server wraps its loader in Nitro's cache, so a
 * rejection propagates out of the cache without ever being stored, and the
 * degraded result produced here never reaches the cache at all.
 */
export async function loadBlogPosts(
  load: () => Promise<BlogPostSummary[]>,
  report: (message: string) => void,
): Promise<BlogQueryResult> {
  try {
    return { posts: await load(), ok: true }
  } catch (error) {
    report(error instanceof Error ? error.message : String(error))
    return { posts: [], ok: false }
  }
}
