# SEO, AEO, and blog content

The `useSeo()` one-call-per-page contract, how `publicPage` meta feeds both `sitemap.xml` and `llms.txt`, structured-data rules, and how `@nuxt/content` blog posts are authored and served.

> **Load this when:** adding or editing a page, writing structured data, changing crawler behaviour, or working in `content/blog/`.
> Canonical index: [AGENTS.md](../../AGENTS.md).

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
  containing `:`, because `/blog/[slug]` is one pattern rather than N URLs. The blog is
  enumerated server-side from content (`server/utils/blog.ts`); **any other set of URLs an app
  owns is registered, not hand-added to the routes**: from a Nitro plugin,
  `registerPublicPageSource({ key, list(db, { buildDate }), llmsHeading?, defaults? })`
  (`server/utils/public-pages.ts`) puts each returned `{ path, title?, description?, lastmod? }`
  in `sitemap.xml`, and in `llms.txt` under `llmsHeading` when it names one. A source that throws
  is logged, skipped, and makes both documents `no-store`, like a failed blog query.
  `registerRobotsDisallow(['/sessions'])` adds private paths to `robots.txt` (wildcard group
  and every named AI crawler). The page still declares `publicPage` (the gate's invariant is
  per-page), with a comment saying the values are inert. The three routes stay identical in
  every fork.
- **Never write FAQ (or any) JSON-LD for content that isn't rendered.** `/pricing`
  builds its `FAQPage` from the same `PRICING_FAQ` array it renders — see
  `app/utils/faq.ts`. Structured data describing invisible content is a manual-action
  risk with Google and a lie an answer engine will repeat.
- **Prices go into schema as numbers**, never display strings. `layers/billing/app/utils/plans.ts`
  carries `amount` + `currency` + `unit` alongside the `'$12'` display copy for exactly
  this reason.
- Structured-data builders live in `shared/utils/schema.ts` and are pure functions of a
  `SiteContext` — add a node type there, unit-test it, then pass it via `useSeo({ schema: [...] })`.
- `NUXT_PUBLIC_INDEXABLE=false` on preview deploys makes robots.txt disallow everything,
  every page render `noindex`, and sitemap/llms.txt go empty. `NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false`
  blocks the named answer-engine crawlers (`server/utils/seo.ts` › `AI_CRAWLERS`); it defaults
  to **true** because being quotable by an answer engine is distribution for a SaaS marketing site.
- **IndexNow** (`server/utils/indexnow.ts`): the 04:00 `seo:indexnow` task reads this app's own
  `/sitemap.xml` and submits every URL whose `<lastmod>` is on or after the last accepted run,
  so Bing (and through it ChatGPT search, Copilot, DuckDuckGo) recrawls changed pages within
  minutes. It reads the served sitemap rather than rebuilding the list, so a fork's custom
  sitemap route needs no port. Opt in with `NUXT_INDEXNOW_KEY` in `[vars]` (8–128 of
  `[A-Za-z0-9-]`, `openssl rand -hex 16`); `/indexnow-key.txt` serves it. It is not a secret.
  Preview deploys and non-https origins never ping. State lives in KV at
  `seo:indexnow:last-submitted` and only advances on a 200/202, so a failed day is resubmitted.
- **`sameAs`**: `runtimeConfig.public.sameAs` lists the organization's own profiles (GitHub, X,
  LinkedIn, Wikidata) and becomes `Organization.sameAs`. Set it when another entity shares the
  name; it is the signal that tells them apart.

## Share cards (og:image)

Every public page gets its own 1200x630 card, drawn at **build time** and served as a static
asset, so the Worker bundle does not grow. `bun run build` runs `scripts/og-images.ts` before
`nuxt build` and `--check` after it.

- **Where cards come from**: every static page with a literal `publicPage` (its `title` and
  `summary` become the card's text), every non-draft post in `content/blog/`, and any
  `layers/*/og-cards.ts` whose default export returns `{ path, title, summary? }[]`. A fork's
  own layer uses that last hook to card the dynamic routes it enumerates (a record's page, a
  per-item landing page); the same module may export `ogHost(path)` to name the footer host of pages
  served somewhere other than the app's own origin. The home page keeps the site card, `public/og.png`.
- **How a page finds its card**: `useSeo()` links `/og/<route>.png` (`ogCardPath()` in
  `shared/utils/og.ts`) when the route is static and declares `publicPage`, else the site card. A
  dynamic route names its own: `useSeo({ image: ogCardPath(route.path) })`, as the blog post does.
  A card for a route nothing drew is a broken preview, so register the card in the same change.
- **Drawing**: `satori` (layout to SVG) and `@resvg/resvg-js` (SVG to PNG), both
  devDependencies. Fonts are the families named in `main.css`, read from `@fontsource/<family>`
  in `node_modules` (woff, not woff2), so no network is needed; a family without a package fails
  the build with the `bun add -d` line to run. Colors are the `og-*` roles, resolved to hex by
  `bun run brand:generate` into `shared/utils/brand-colors.generated.ts` (a build has no
  browser). The card layout lives in `scripts/lib/og-render.ts`; edit it for a rebrand.
- **Not here**: anything that changes between builds. A card is a title and one line of
  context, never a live number. Per-record cards that must be drawn per request would need a
  runtime renderer, which this template deliberately does not ship (the compressed Worker
  limit on the free plan is about 3 MB).
- `public/og/` is gitignored and absent under `bun dev`, so a dev render links to a missing
  file; run `bun run og:build` to see them locally.

## Page collections (one page per row of product data)

A fork with data it already owns (a catalogue, scenarios, rules, glossary entries) declares a
**collection** and gets a real page per row: `useSeo()` with the row's own title and
description, canonical, breadcrumb, JSON-LD where a type fits, an entry in `sitemap.xml` and
`llms.txt`, and an IndexNow submission whenever the row's `lastmod` moves. It is core, not a
layer: it is the SEO contract above extended (each collection is a `registerPublicPageSource()`,
each page a `useSeo()` call), and `seo:check` must enforce it without importing a layer.

- **Declare** it with `definePageCollection<Row>({ … })` (`shared/utils/page-collections.ts`) and
  list it in `server/utils/page-collections-app.ts`, which the app owns. That list is the one
  declaration: `server/plugins/page-collections.ts` registers it, `seo:check` builds it, and the
  a11y sweep reads its route prefixes. Keep the definition module alias-free (relative imports),
  as the gate loads it outside Nuxt.
- **Fields**: `key`; `route` (`/glossary/[slug]`, one `[slug]` last); `slug` (the row field
  holding the URL segment); `heading` (llms.txt section and breadcrumb name of `indexPath`);
  `title`, `description` and `h1` as `{field}` templates; `sections` (`{ heading, field }`, a
  string renders as paragraphs split on blank lines, a string list as a list); optional `facts`
  (`{ label, field }`), `schema` (`{ type, properties: { name: 'term' } }`), `lastmod` (a field
  holding `YYYY-MM-DD`), `minWords` (raise the thin floor), `llms: false`; and `rows(db)`. When
  `rows` reads D1, give `examples`: real rows the gate builds instead.
- **Page file** at the route, calling `useCollectionPage('<key>')`, which fetches
  `GET /api/collection-pages/<key>/<slug>` and is the page's one `useSeo()` call (the gate fails a
  page that also calls `useSeo()`). Render the result with `<CollectionPage :page />` or from
  the same fields. It still declares an inert `publicPage`, like `/blog/[slug]`. Give the
  collection an index page that links every published row (`GET /api/collection-pages/<key>`),
  or the pages are reachable only from the sitemap.
- **Every fact comes from the row.** The fixed copy (templates, section headings, fact labels) is
  the same on every page and may hold no digits and no quotation marks; JSON-LD may describe only
  fields the page renders, and no review, rating or testimonial type or property. Nothing else
  can put text on a generated page.
- **Guards** (`shared/utils/page-guards.ts`, one function in the Worker and the gate). A row is
  not published when its page is thin (under `THIN_PAGE_MIN_WORDS`, 80, words of row text), its
  title or description is out of bounds or repeats a hand-written page's or an earlier row's, or
  its body is a near-copy of an earlier page (`NEAR_COPY_SIMILARITY`: 0.8 Jaccard over word
  3-shingles). In the Worker an unpublished row is a 404 and absent from both documents, logged
  as `page_collection_row_unpublished`; in `seo:check` it fails the build, for every static row
  and every example. Fix the row from the product data; never pad it.
- **Rows are read at most every five minutes per isolate**, so a new row is live within that.
  A `rows()` that throws makes sitemap.xml and llms.txt `no-store`, like a failed blog query.
- **Worked example**: the glossary, `shared/page-collections/glossary.ts` with its terms in
  `glossary-terms.ts` (app-owned), at `/glossary` and `/glossary/<slug>`. A fork replaces the
  terms with its own or removes the glossary (TEARDOWN.md).

## Search Console (owner steps, then fleet reads it)

Nothing in an app collects Search Console. Fleet will collect it with one read-only identity
and serve it on each product's scoreboard (`GET /api/scoreboard/<slug>`), which the
`seo-content` routine reads. Until then the `search` field is absent, and the routine skips its
click-based steps.

**Owner steps** (both consoles want the owner's own Google account, so an agent cannot do
these), once per domain: `drawthesystem.com`, `woolholm.com` (a Domain property covers
`app.woolholm.com`), `pocket-film-school.com`.

1. **Verify by DNS.** Google Search Console → Add property → *Domain* → enter the apex → copy the
   `google-site-verification=…` TXT value. Add it as a TXT record at the apex in Cloudflare
   (`cf cli search "create dns record"`; the mini's token cannot edit DNS, so from the laptop or
   the dashboard), then Verify. DNS rather than a meta tag: it survives redesigns and needs no
   deploy.
2. **Submit the sitemap**: the property → Sitemaps → `https://<prod host>/sitemap.xml`.
3. **Make fleet's identity**, once for all three: in Google Cloud console, create a project
   (`fleet-search`), enable the *Google Search Console API*, and create a service account in it
   with no project roles. Create a JSON key for it and save it in 1Password's `Agents` vault as
   `Fleet Search Console service account`, so fleet can be given it as a secret with
   `op read … | bunx wrangler secret put`.
4. **Grant it read access**: in each property, Settings → Users and permissions → Add user →
   the service account's `…@….iam.gserviceaccount.com` address → Permission **Restricted**
   (read-only; it cannot change settings or submit anything).
5. **Bing Webmaster Tools** (optional): *Import from Google Search Console*, which carries the
   verification and the sitemap.

**The contract** fleet serves, inside the scoreboard JSON:

```ts
search?: {
  range: { from: string; to: string } // YYYY-MM-DD, inclusive, UTC: the last 28 days Search Console has finished
  pages: {
    path: string // the page's path on the product's own origin, e.g. /glossary/magic-link
    clicks: number // clicks in range
    impressions: number // impressions in range
    position: number // average position in range, 1 = top
    clicksPrev: number // clicks in the 28 days before range.from
  }[]
}
```

Absent means no access or no collection yet, never zero traffic. A page is listed when it had an
impression in either window, so a page that lost every click still shows, with `clicks: 0`. Search Console reports a day only once it has finished processing it (about
two days late), which is why `range.to` is not today.

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


