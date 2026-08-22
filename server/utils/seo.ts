// Bodies for /robots.txt, /sitemap.xml and /llms.txt, as pure functions.
//
// Split out of the routes so they can be asserted directly (test/seo.test.ts)
// rather than by booting a Worker and parsing text. These three files are the
// only place the app tells crawlers what it wants, and they are exactly the
// kind of thing that breaks silently — nobody notices a wrong robots.txt until
// traffic is already gone.

import type { PublicPage } from '#shared/utils/site'
import { absoluteUrl, escapeXml, normalizeOrigin } from '#shared/utils/site'

/**
 * The crawlers behind answer engines and model training, named explicitly.
 *
 * They are listed rather than left to `User-agent: *` for one reason: a policy
 * you can read is a policy you can change. Whoever forks this should be able to
 * see which bots they are admitting and flip one flag, instead of discovering
 * months later that a wildcard made the decision for them.
 *
 * `purpose` is documentation for that decision, not something robots.txt emits.
 */
export const AI_CRAWLERS: { agent: string; purpose: string }[] = [
  { agent: 'GPTBot', purpose: 'OpenAI — model training' },
  { agent: 'OAI-SearchBot', purpose: 'OpenAI — ChatGPT Search index' },
  { agent: 'ChatGPT-User', purpose: 'OpenAI — fetches a page a user linked' },
  { agent: 'ClaudeBot', purpose: 'Anthropic — model training' },
  { agent: 'Claude-SearchBot', purpose: 'Anthropic — search index' },
  { agent: 'Claude-User', purpose: 'Anthropic — fetches a page a user linked' },
  { agent: 'PerplexityBot', purpose: 'Perplexity — search index' },
  { agent: 'Perplexity-User', purpose: 'Perplexity — fetches a page a user linked' },
  { agent: 'Google-Extended', purpose: 'Google — Gemini training and AI Overviews grounding' },
  { agent: 'Applebot-Extended', purpose: 'Apple — model training' },
  { agent: 'meta-externalagent', purpose: 'Meta — model training' },
  { agent: 'Bytespider', purpose: 'ByteDance — model training' },
  { agent: 'CCBot', purpose: 'Common Crawl — corpus most open models train on' },
]

/**
 * Paths no crawler should spend budget on: private areas, the API surface, the
 * analytics proxy, and OAuth callbacks (which are redirects with single-use
 * codes in them, worthless in an index).
 */
const DISALLOWED = ['/account', '/dashboard', '/login', '/api/', '/ingest/']

export interface RobotsInput {
  appUrl: string
  indexable: boolean
  allowAiCrawlers: boolean
}

export function buildRobotsTxt(input: RobotsInput): string {
  const appUrl = normalizeOrigin(input.appUrl)

  // A preview build has no business in a search index — and worse, an indexed
  // preview URL competes with production for the same content. Same when no
  // canonical origin is configured: without one the Sitemap line would be
  // unresolvable anyway.
  if (!input.indexable || !appUrl) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n')
  }

  const lines = ['User-agent: *', 'Allow: /', ...DISALLOWED.map((path) => `Disallow: ${path}`), '']

  lines.push(
    input.allowAiCrawlers
      ? '# Answer engines and model crawlers are allowed on the public pages.'
      : '# Answer engines and model crawlers are blocked (NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false).',
  )

  for (const { agent } of AI_CRAWLERS) {
    lines.push(`User-agent: ${agent}`)
    if (input.allowAiCrawlers) {
      lines.push('Allow: /', ...DISALLOWED.map((path) => `Disallow: ${path}`))
    } else {
      lines.push('Disallow: /')
    }
    lines.push('')
  }

  lines.push(`Sitemap: ${appUrl}/sitemap.xml`, '')
  return lines.join('\n')
}

/** One `<url>` in sitemap.xml. `lastmod` is per-entry — see below. */
export interface SitemapEntry {
  path: string
  changefreq: PublicPage['changefreq']
  priority: string
  /** `YYYY-MM-DD`. */
  lastmod: string
}

export interface SitemapInput {
  appUrl: string
  indexable: boolean
  entries: SitemapEntry[]
}

const EMPTY_SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'

/**
 * /sitemap.xml.
 *
 * `lastmod` arrives per entry rather than being stamped here, because the two
 * kinds of URL in this sitemap know different things. A static page has only
 * the build date — the honest per-page alternative is git history, which CI
 * clones shallowly (nuxt.config.ts › runtimeConfig.buildDate). A blog post has
 * a real publication date in its frontmatter, and telling a crawler that a
 * two-month-old post changed today is how a site teaches Google to ignore its
 * lastmod entirely.
 *
 * An empty but well-formed document rather than a 404 when there is nothing to
 * publish: a broken sitemap is a crawl error, an empty one is a fact.
 */
export function buildSitemap(input: SitemapInput): string {
  const appUrl = normalizeOrigin(input.appUrl)

  // No canonical origin means every <loc> would be relative, which is invalid.
  // Preview deploys are suppressed for the same reason robots.txt is.
  if (!appUrl || !input.indexable || input.entries.length === 0) return EMPTY_SITEMAP

  const urls = input.entries
    .map((entry) => {
      const loc = escapeXml(absoluteUrl(appUrl, entry.path))
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${entry.lastmod}</lastmod>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
}

/**
 * The date a crawler should treat as a post's last modification.
 *
 * Here rather than next to the query in server/utils/blog.ts for one practical
 * reason: that module imports @nuxt/content's Nitro entry, which resolves a
 * `#content/*` build alias that does not exist inside the workerd vitest pool.
 * This rule is the whole point of querying the collection for the sitemap, so
 * it belongs somewhere a test can reach it.
 */
export function blogPostLastmod(post: { date: string; updated?: string }): string {
  return post.updated || post.date
}

/** One blog post, as llms.txt lists it. */
export interface LlmsTxtPost {
  path: string
  title: string
  description: string
  /** `YYYY-MM-DD`. Stated because a model has no other way to date a claim. */
  date: string
}

export interface LlmsTxtInput {
  appName: string
  appUrl: string
  /** One-paragraph description of the product, used as the blockquote. */
  description: string
  supportEmail: string
  legalEntity: string
  pages: PublicPage[]
  /** Newest first. Listed under their own heading, below the pages. */
  posts?: LlmsTxtPost[]
}

/**
 * /llms.txt — the llmstxt.org convention: a short, stable, Markdown map of the
 * site for a model that has limited context and no patience for navigation.
 *
 * It is a map, not a mirror. Every line is a link plus one sentence saying what
 * is behind it, so a model can decide what to fetch rather than guessing from a
 * rendered page full of buttons and cookie banners. Duplicating the pages'
 * actual content here would create a second copy to keep in sync, and a stale
 * price in a machine-readable file is worse than no file.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const appUrl = normalizeOrigin(input.appUrl)
  const sections: string[] = [`# ${input.appName}`, '', `> ${input.description}`, '']

  if (input.pages.length > 0) {
    sections.push('## Pages', '')
    for (const page of input.pages) {
      sections.push(`- [${page.title}](${absoluteUrl(appUrl, page.path)}): ${page.summary}`)
    }
    sections.push('')
  }

  // Posts get their own heading rather than being folded in with the pages.
  // They are a different kind of thing — dated, numerous, and worth quoting on
  // their own — and the date belongs on the line for the same reason
  // `dateModified` belongs in the JSON-LD: a model that cannot tell how old a
  // claim is will repeat it as current.
  if (input.posts?.length) {
    sections.push('## Blog', '')
    for (const post of input.posts) {
      sections.push(
        `- [${post.title}](${absoluteUrl(appUrl, post.path)}): ${post.description} (published ${post.date})`,
      )
    }
    sections.push('')
  }

  sections.push(
    '## About',
    '',
    `- Operated by ${input.legalEntity}.`,
    `- Support: ${input.supportEmail}`,
    `- Structured data for each page is published as schema.org JSON-LD in the page head.`,
    '',
  )

  return sections.join('\n')
}
