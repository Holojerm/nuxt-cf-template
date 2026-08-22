# SEO, AEO, and blog content

The `useSeo()` one-call-per-page contract, how `publicPage` meta feeds both `sitemap.xml` and `llms.txt`, structured-data rules, and how `@nuxt/content` blog posts are authored and served.

> **Load this when:** adding or editing a page, writing structured data, changing crawler behaviour, or working in `content/blog/`.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

## SEO & AEO

- **Every page calls `useSeo()` exactly once.** It is the only thing that emits
  `<link rel="canonical">`, Open Graph, Twitter cards, and JSON-LD. `bun run seo:check`
  (part of `bun run ci`) fails the build on a page that skips it or that calls
  `useSeoMeta()`/`useHead()` to set SEO tags directly.
- **Public pages declare themselves**: `definePageMeta({ publicPage: { changefreq, priority, title, summary } })`.
  That one declaration is what puts a page in **both** `sitemap.xml` and `llms.txt` —
  there is no list to update. A page without it is in neither, which is the right
  default. `noindex: true` and `publicPage` are mutually exclusive and the gate enforces it.
- **A dynamic route cannot reach either file that way.** The collecting hook skips any path
  containing `:`, because `/blog/[slug]` is one pattern rather than N URLs. Enumerate those
  server-side in `sitemap.xml.get.ts` / `llms.txt.get.ts` — see `server/utils/blog.ts`. The
  page still declares `publicPage` (the gate's invariant is per-page), with a comment saying
  the values are inert.
- **Never write FAQ (or any) JSON-LD for content that isn't rendered.** `/pricing`
  builds its `FAQPage` from the same `PRICING_FAQ` array it renders — see
  `app/utils/faq.ts`. Structured data describing invisible content is a manual-action
  risk with Google and a lie an answer engine will repeat.
- **Prices go into schema as numbers**, never display strings. `app/utils/plans.ts`
  carries `amount` + `currency` + `unit` alongside the `'$12'` display copy for exactly
  this reason.
- Structured-data builders live in `shared/utils/schema.ts` and are pure functions of a
  `SiteContext` — add a node type there, unit-test it, then pass it via `useSeo({ schema: [...] })`.
- `NUXT_PUBLIC_INDEXABLE=false` on preview deploys makes robots.txt disallow everything,
  every page render `noindex`, and sitemap/llms.txt go empty. `NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false`
  blocks the named answer-engine crawlers (`server/utils/seo.ts` › `AI_CRAWLERS`); it defaults
  to **true** because being quotable by an answer engine is distribution for a SaaS marketing site.

## Blog content (@nuxt/content)

- **A post is a markdown file in `content/blog/`.** The filename is the URL. Frontmatter is
  `title`, `description`, `date`, `author`, and optional `updated` and `draft`, declared in
  `content.config.ts`. Quote the dates — unquoted YAML dates become `Date` objects and lose a
  day to a timezone somewhere between YAML, SQLite, and JSON.
- **The schema does not enforce its own bounds.** Content turns a collection schema into SQL
  columns; it never runs the refinements against your frontmatter. Only the *types* and
  *defaults* are real. `bun run seo:check` reads `content/blog/*.md` and applies the
  title/description limits there instead, plus dates that are well-formed, not in the future,
  and in the right order.
- **`draft: true` hides a post from every list** (the query filters it, so it is absent from
  /blog, sitemap.xml, and llms.txt) but leaves its URL readable in dev and 404 in production.
  The rule is `isPostVisible()` in `shared/utils/blog.ts` — one function, tested, called from
  the slug route.
- **Never call `queryCollection()` from app code.** On the client it downloads the collection
  dump and runs it through `@sqlite.org/sqlite-wasm` — a megabyte of WebAssembly, and blocked
  by this app's CSP, which does not grant `'wasm-unsafe-eval'`. Query it in `server/`
  (`server/utils/blog.ts`) and have pages `useFetch('/api/blog…')`.
- **Content lives in the app's own `DB` D1 binding** as `_content_*` tables, and needs no
  Drizzle migration: the Worker imports the build's SQL dump on the first request after a
  deploy. Do not run `drizzle-kit push` — it diffs against the live database and would try to
  drop them.
- Render with `<ContentRenderer>`; NuxtUI's `Prose*` components are registered automatically
  and are themed under `ui.prose` in `app/app.config.ts` (DESIGN.md › Component behavior ›
  Long-form content).


