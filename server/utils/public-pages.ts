// Dynamic public pages and crawler hints: the places sitemap.xml, llms.txt and
// robots.txt need something only an app (or one of its layers) knows.
//
// Static pages declare themselves with `definePageMeta({ publicPage })` and the
// blog is queried from content. What neither can reach is "one route, N URLs"
// from the app's own data: a problem catalogue, a public profile, an alert
// permalink. Forks used to append those inside the sitemap and llms.txt routes
// and edit the DISALLOWED list in server/utils/seo.ts, so all three files were
// hand-ported on every template sync.
//
// A source is registered from a Nitro plugin instead, with the same plain-module
// registry as server/utils/extensions.ts (no Nitro hooks, so the workerd vitest
// pool can call the same functions):
//
//   registerPublicPageSource({
//     key: 'problems',
//     llmsHeading: 'Practice problems',
//     list: async (db) => (await listProblems(db)).map((p) => ({
//       path: `/problems/${p.slug}`, title: p.title, description: p.ask,
//     })),
//   })
//   registerRobotsDisallow(['/sessions', '/companies'])
//
// With nothing registered the three documents are byte-identical to before.

import type { ExtensionDb } from './extensions'
import type { LlmsTxtSection, SitemapEntry } from './seo'

/** One URL a source contributes. */
export interface PublicPageItem {
  path: string
  /** Required to appear in llms.txt; ignored by sitemap.xml. */
  title?: string
  /** One sentence for llms.txt: what is behind the link. */
  description?: string
  /** `YYYY-MM-DD`. Defaults to the build date, which is what static pages use. */
  lastmod?: string
  changefreq?: SitemapEntry['changefreq']
  priority?: string
}

export interface PublicPageContext {
  /** `runtimeConfig.buildDate`, the lastmod a page with no date of its own gets. */
  buildDate: string
}

export interface PublicPageSource {
  key: string
  /**
   * Every public URL this source owns. Throwing marks the crawler documents
   * degraded (served, but `no-store`): "the pages are missing" and "the pages
   * were removed" are the same bytes to a crawler.
   */
  list: (db: ExtensionDb, context: PublicPageContext) => Promise<PublicPageItem[]>
  /** Crawl hints for items that do not set their own. Default: monthly, 0.5. */
  defaults?: { changefreq?: SitemapEntry['changefreq']; priority?: string }
  /** Also list the items in llms.txt under this heading. Omit to keep them out. */
  llmsHeading?: string
}

// Keyed, so registering twice (plugin + test, or a dev reload) replaces.
const sources = new Map<string, PublicPageSource>()
const robotsDisallow = new Set<string>()

export function registerPublicPageSource(source: PublicPageSource): void {
  sources.set(source.key, source)
}

export function getPublicPageSources(): PublicPageSource[] {
  return [...sources.values()]
}

/**
 * Paths crawlers should not spend budget on, beyond core's own list (account,
 * login, /api/, /ingest/). Each must start with `/`. Applies to the wildcard
 * group and to every named AI crawler.
 */
export function registerRobotsDisallow(paths: readonly string[]): void {
  for (const path of paths) {
    if (!path.startsWith('/')) {
      throw new Error(`registerRobotsDisallow: "${path}" must start with "/"`)
    }
    robotsDisallow.add(path)
  }
}

export function getRobotsDisallow(): string[] {
  return [...robotsDisallow]
}

export interface CollectedPublicPages {
  /** Appended to the sitemap after static pages and posts. */
  entries: SitemapEntry[]
  /** Rendered in llms.txt between the blog and About. */
  sections: LlmsTxtSection[]
  /** False when any source threw — the caller must not cache the documents. */
  complete: boolean
}

/**
 * Ask every source for its pages. A failing source is logged and skipped rather
 * than failing the document: a sitemap missing one source beats a 500 that costs
 * all crawl coverage. `complete: false` is how the caller learns to say so.
 */
export async function collectPublicPages(
  db: ExtensionDb,
  context: PublicPageContext,
  list: PublicPageSource[] = getPublicPageSources(),
): Promise<CollectedPublicPages> {
  const results = await Promise.all(
    list.map(async (source) => {
      try {
        return { source, items: await source.list(db, context), ok: true }
      } catch (error) {
        console.warn(
          JSON.stringify({
            kind: 'public_page_source_failed',
            key: source.key,
            error: String(error),
          }),
        )
        return { source, items: [] as PublicPageItem[], ok: false }
      }
    }),
  )

  const entries: SitemapEntry[] = []
  const sections: LlmsTxtSection[] = []
  for (const { source, items } of results) {
    for (const item of items) {
      entries.push({
        path: item.path,
        changefreq: item.changefreq ?? source.defaults?.changefreq ?? 'monthly',
        priority: item.priority ?? source.defaults?.priority ?? '0.5',
        lastmod: item.lastmod ?? context.buildDate,
      })
    }
    if (source.llmsHeading) {
      const links = items.flatMap((item) =>
        item.title && item.description
          ? [{ path: item.path, title: item.title, description: item.description }]
          : [],
      )
      if (links.length > 0) sections.push({ heading: source.llmsHeading, links })
    }
  }

  return { entries, sections, complete: results.every((r) => r.ok) }
}

/** Test-only: forget every registration, to exercise core with nothing added. */
export function clearPublicPagesForTest(): void {
  sources.clear()
  robotsDisallow.clear()
}
