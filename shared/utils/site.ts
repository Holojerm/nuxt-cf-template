// Origin and URL helpers, shared by `app/` and `server/`.
//
// Lives in `shared/` because both halves need the same answer: the composable
// that writes <link rel="canonical"> in the browser and the Nitro route that
// writes <loc> into sitemap.xml must agree on what a page's URL is, or you
// publish two spellings of the same page and split its ranking between them.
//
// Everything here is pure — no runtime config, no request context — so the
// rules are testable without booting Nuxt (see test/seo.test.ts).

/** Strip trailing slashes so `appUrl` + path never produces a double slash. */
export function normalizeOrigin(url: string | undefined): string {
  return (url || '').replace(/\/+$/, '')
}

/**
 * The canonical spelling of a route path: leading slash, no trailing slash, no
 * query string, no hash. `/pricing/?ref=x` and `/pricing` are one page, and
 * only one of them belongs in a canonical tag or a sitemap.
 */
export function canonicalPath(path: string): string {
  const [withoutHash = ''] = path.split('#')
  const [withoutQuery = ''] = withoutHash.split('?')
  const trimmed = withoutQuery.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * Absolute URL for a route path. Returns an empty string when no origin is
 * configured — callers skip the tag entirely rather than emitting a relative
 * canonical, which crawlers treat as self-referential and ignore.
 */
export function absoluteUrl(origin: string | undefined, path = '/'): string {
  const base = normalizeOrigin(origin)
  if (!base) return ''
  const route = canonicalPath(path)
  return route === '/' ? base : `${base}${route}`
}

/** XML/HTML text escape, for hand-built sitemap and JSON-LD payloads. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * One public page, as declared on the page itself via
 * `definePageMeta({ publicPage: … })` (see app/types/seo.d.ts), collected at
 * build time by the `pages:extend` hook in nuxt.config.ts.
 *
 * Two consumers, one declaration: sitemap.xml renders the crawl hints, and
 * llms.txt renders the summary. A page is public because it says so, not
 * because someone remembered to add it to a list in a second file.
 */
export interface PublicPage {
  path: string
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  priority: string
  /** Human title for llms.txt. */
  title: string
  /** One sentence, for llms.txt — what a model would find on this page. */
  summary: string
}
