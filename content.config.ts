// Content collections — the schema half of the blog. Markdown lives in
// content/blog/; this file says what a post is allowed to look like.
//
// `type: 'page'` means every file maps to a URL: content/blog/foo.md is served
// at /blog/foo by app/pages/blog/[slug].vue. It also brings the built-in page
// fields (`path`, `title`, `description`, `body`, `stem`) for free — the schema
// below only adds what a post needs on top, plus tighter bounds on the two
// fields search engines actually render.
//
// Why `z` from '@nuxt/content' rather than the app's Zod 4: this is the
// module's own config file, and the module re-exports the exact validator
// build it converts to a JSON Schema and then to SQL columns. Handing it a
// different Zod instance is a cross-version detail with no upside here — the
// app's own input validation (server/api/**) is still Zod 4, as CLAUDE.md says.
//
// ── This schema is a column definition, not a validator ─────────────────────
// Read that literally. Content walks the schema to derive SQL columns, their
// types, and their defaults; it never runs it against your frontmatter. So the
// TYPES below are real — a `draft` column is BOOLEAN, an absent one takes the
// declared default — and every REFINEMENT below is documentation: `.min(50)`,
// `.max(70)`, and the `isoDate` regex all pass silently on frontmatter that
// violates them. `bun run seo:check` re-states those rules against the markdown
// files themselves, and that is the copy that fails a build. Keep the two in
// step; scripts/check-seo.ts points back here.

import { defineCollection, defineContentConfig, z } from '@nuxt/content'

/**
 * ISO calendar date, `YYYY-MM-DD`.
 *
 * A string rather than `z.date()`, and quoted in frontmatter, on purpose: an
 * unquoted YAML date is parsed into a JS Date and then re-serialised through
 * SQLite and JSON, which is three chances to pick up a timezone that shifts the
 * day. Both consumers — `<time datetime>` and the sitemap's `<lastmod>` — want
 * exactly these ten characters, so store exactly these ten characters.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

export default defineContentConfig({
  collections: {
    blog: defineCollection({
      type: 'page',
      source: 'blog/**',
      schema: z.object({
        // Redeclared over the built-in page fields to attach the length bounds
        // the SEO gate checks. Google renders roughly 155 characters of the
        // description and about 60 of the title.
        title: z.string().min(1).max(70),
        description: z.string().min(50).max(160),
        /** Publication date. Drives sort order, `datePublished`, and `lastmod`. */
        date: isoDate,
        /** Last substantive edit. Omit it rather than repeating `date`. */
        updated: isoDate.optional(),
        /** Byline. Becomes the `author` Person node in the post's JSON-LD. */
        author: z.string().min(1),
        /**
         * Unfinished. Never listed anywhere; openable by URL in dev only —
         * see `isPostVisible()` in shared/utils/blog.ts.
         *
         * `.default(false)` rather than `.optional()`, and that is the one
         * refinement on this page that genuinely does something: content writes
         * the declared default into the column when the key is absent, so
         * `draft` is never NULL and the query can filter with a plain `= false`
         * instead of tripping over SQL three-valued logic.
         */
        draft: z.boolean().default(false),
      }),
    }),
  },
})
