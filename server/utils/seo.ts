// Bodies for /robots.txt and /llms.txt, as pure functions.
//
// Split out of the routes so they can be asserted directly (test/seo.test.ts)
// rather than by booting a Worker and parsing text. These two files are the
// only place the app tells crawlers what it wants, and they are exactly the
// kind of thing that breaks silently — nobody notices a wrong robots.txt until
// traffic is already gone.

import type { PublicPage } from '#shared/utils/site'
import { absoluteUrl, normalizeOrigin } from '#shared/utils/site'

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

export interface LlmsTxtInput {
  appName: string
  appUrl: string
  /** One-paragraph description of the product, used as the blockquote. */
  description: string
  supportEmail: string
  legalEntity: string
  pages: PublicPage[]
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
