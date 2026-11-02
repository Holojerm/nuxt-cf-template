// Public page sources: what an app registers so sitemap.xml, llms.txt and
// robots.txt can list pages that exist only as rows or data. The documents
// themselves are built by server/utils/seo.ts (test/seo.test.ts); this covers
// the registry in front of them, and that registering nothing changes nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearPublicPagesForTest,
  collectPublicPages,
  getRobotsDisallow,
  registerPublicPageSource,
  registerRobotsDisallow,
} from '../server/utils/public-pages'
import type { ExtensionDb } from '../server/utils/extensions'
import { buildLlmsTxt, buildRobotsTxt, sitemapResponse } from '../server/utils/seo'

// Sources receive the client; these tests fake it the way test/extensions does
// not need to, because no source here reads it.
const DB = {} as ExtensionDb
const CONTEXT = { buildDate: '2026-11-02' }

const SITE = { appUrl: 'https://example.com', indexable: true }
const LLMS = {
  appName: 'Example',
  appUrl: 'https://example.com',
  description: 'An example.',
  supportEmail: 'help@example.com',
  legalEntity: 'Example Ltd',
  pages: [],
}

afterEach(() => clearPublicPagesForTest())

describe('with nothing registered', () => {
  it('contributes nothing, and the documents match what core builds alone', async () => {
    const collected = await collectPublicPages(DB, CONTEXT)
    expect(collected).toEqual({ entries: [], sections: [], complete: true })

    const bare = { ...SITE, buildDate: CONTEXT.buildDate, pages: [], posts: [], complete: true }
    expect(sitemapResponse({ ...bare, dynamic: collected.entries })).toEqual(sitemapResponse(bare))
    expect(buildLlmsTxt({ ...LLMS, sections: collected.sections })).toBe(buildLlmsTxt(LLMS))
    expect(buildRobotsTxt({ ...SITE, allowAiCrawlers: true, disallow: getRobotsDisallow() })).toBe(
      buildRobotsTxt({ ...SITE, allowAiCrawlers: true }),
    )
  })
})

describe('registerPublicPageSource', () => {
  const problems = {
    key: 'problems',
    llmsHeading: 'Practice problems',
    defaults: { changefreq: 'weekly' as const, priority: '0.6' },
    list: async () => [
      { path: '/problems/url-shortener', title: 'URL shortener', description: 'Design a TinyURL.' },
      { path: '/problems/rate-limiter', title: 'Rate limiter', description: 'Throttle a caller.' },
    ],
  }

  it('turns items into sitemap entries with the source defaults and the build date', async () => {
    registerPublicPageSource(problems)
    const { entries } = await collectPublicPages(DB, CONTEXT)
    expect(entries).toEqual([
      {
        path: '/problems/url-shortener',
        changefreq: 'weekly',
        priority: '0.6',
        lastmod: '2026-11-02',
      },
      {
        path: '/problems/rate-limiter',
        changefreq: 'weekly',
        priority: '0.6',
        lastmod: '2026-11-02',
      },
    ])
  })

  it('lets an item override lastmod and crawl hints, else falls back to monthly 0.5', async () => {
    registerPublicPageSource({
      key: 'alerts',
      list: async () => [
        { path: '/alerts/1', lastmod: '2026-10-01', changefreq: 'yearly', priority: '0.3' },
        { path: '/alerts/2' },
      ],
    })
    const { entries } = await collectPublicPages(DB, CONTEXT)
    expect(entries[0]).toEqual({
      path: '/alerts/1',
      changefreq: 'yearly',
      priority: '0.3',
      lastmod: '2026-10-01',
    })
    expect(entries[1]).toMatchObject({ changefreq: 'monthly', priority: '0.5' })
  })

  it('reaches the real documents', async () => {
    registerPublicPageSource(problems)
    const { entries, sections } = await collectPublicPages(DB, CONTEXT)

    const xml = sitemapResponse({
      ...SITE,
      buildDate: CONTEXT.buildDate,
      pages: [],
      posts: [],
      dynamic: entries,
      complete: true,
    }).body
    expect(xml).toContain('<loc>https://example.com/problems/url-shortener</loc>')
    expect(xml.match(/<url>/g)).toHaveLength(2)

    const txt = buildLlmsTxt({ ...LLMS, sections })
    expect(txt).toContain('## Practice problems')
    expect(txt).toContain(
      '- [URL shortener](https://example.com/problems/url-shortener): Design a TinyURL.',
    )
    // Between the content and the About block, where a reader looks for it.
    expect(txt.indexOf('## Practice problems')).toBeLessThan(txt.indexOf('## About'))
  })

  it('keeps a source out of llms.txt unless it names a heading, or lacks a title', async () => {
    registerPublicPageSource({
      key: 'quiet',
      list: async () => [{ path: '/q/1', title: 't', description: 'd' }],
    })
    registerPublicPageSource({
      key: 'untitled',
      llmsHeading: 'Untitled',
      list: async () => [{ path: '/u/1' }],
    })
    const { entries, sections } = await collectPublicPages(DB, CONTEXT)
    expect(entries).toHaveLength(2)
    expect(sections).toEqual([])
  })

  it('serves the rest but reports a failing source as incomplete, so it is not cached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerPublicPageSource(problems)
    registerPublicPageSource({
      key: 'broken',
      list: async () => {
        throw new Error('d1 unavailable')
      },
    })

    const collected = await collectPublicPages(DB, CONTEXT)
    expect(collected.entries).toHaveLength(2)
    expect(collected.complete).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"key":"broken"'))
    warn.mockRestore()

    const { cacheControl } = sitemapResponse({
      ...SITE,
      buildDate: CONTEXT.buildDate,
      pages: [],
      posts: [],
      complete: collected.complete,
    })
    expect(cacheControl).toBe('no-store')
  })

  it('replaces a source registered twice under one key', async () => {
    registerPublicPageSource({ key: 'k', list: async () => [{ path: '/a' }] })
    registerPublicPageSource({ key: 'k', list: async () => [{ path: '/b' }] })
    const { entries } = await collectPublicPages(DB, CONTEXT)
    expect(entries.map((e) => e.path)).toEqual(['/b'])
  })
})

describe('registerRobotsDisallow', () => {
  it('adds paths to the wildcard group and to every AI crawler, once each', () => {
    registerRobotsDisallow(['/sessions', '/companies'])
    registerRobotsDisallow(['/sessions', '/account'])
    const body = buildRobotsTxt({
      ...SITE,
      allowAiCrawlers: true,
      disallow: getRobotsDisallow(),
    })

    expect(body).toContain('Disallow: /sessions')
    const gpt = body.slice(body.indexOf('User-agent: GPTBot'))
    expect(gpt).toContain('Disallow: /companies')
    // /account is core's already; naming it again must not print it twice.
    const wildcard = body.slice(0, body.indexOf('# Answer engines'))
    expect(wildcard.match(/^Disallow: \/account$/gm)).toHaveLength(1)
  })

  it('refuses a path that does not start with a slash', () => {
    expect(() => registerRobotsDisallow(['sessions'])).toThrow(/must start with/)
  })
})
