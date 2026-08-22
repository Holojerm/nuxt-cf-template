// How long a title and a description are allowed to be, in one place.
//
// These numbers are enforced in two directions by two different programs, and
// they were previously written out twice with a comment asking the reader to
// keep them in step:
//
//   * content.config.ts turns them into a collection schema — documentation
//     only, since @nuxt/content derives SQL columns from a schema and never
//     runs its refinements against frontmatter.
//   * scripts/check-seo.ts is the copy that actually fails a build, both for
//     `useSeo()` calls in app/pages/**.vue and for content/blog/*.md.
//
// A drifted pair here is the worst kind of drift: the schema says one thing,
// the gate enforces another, and the person reading the schema is the person
// writing the post.
//
// Nothing here is Nuxt-specific, so both a Bun script and the app can import
// it. (`scripts/` reaches it by relative path — it is outside the `#shared`
// alias, which only exists inside a Nuxt build.)

/** Under ~50 characters is rarely a real sentence. */
export const DESCRIPTION_MIN = 50

/** Google renders roughly 155 characters of a description before truncating. */
export const DESCRIPTION_MAX = 160

/** And roughly 60 of a title; 70 leaves a little room before it substitutes. */
export const TITLE_MAX = 70
