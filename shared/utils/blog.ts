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
