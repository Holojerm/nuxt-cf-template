import { describe, expect, it } from 'vitest'

import {
  indexNowPayloads,
  indexNowSkipReason,
  isValidIndexNowKey,
  parseSitemapUrls,
  urlsChangedSince,
  INDEXNOW_MAX_URLS,
} from '../server/utils/indexnow'
import { buildSitemap } from '../server/utils/seo'

const KEY = 'a1b2c3d4e5f60718'

describe('parseSitemapUrls', () => {
  it('reads back exactly what buildSitemap wrote, escapes included', () => {
    const xml = buildSitemap({
      appUrl: 'https://example.com',
      indexable: true,
      entries: [
        { path: '/', changefreq: 'daily', priority: '1.0', lastmod: '2026-11-01' },
        { path: '/a&b', changefreq: 'weekly', priority: '0.5', lastmod: '2026-10-01' },
      ],
    })
    expect(parseSitemapUrls(xml)).toEqual([
      { loc: 'https://example.com', lastmod: '2026-11-01' },
      { loc: 'https://example.com/a&b', lastmod: '2026-10-01' },
    ])
  })

  it('keeps a url with no lastmod', () => {
    expect(parseSitemapUrls('<urlset><url><loc>https://x.com/p</loc></url></urlset>')).toEqual([
      { loc: 'https://x.com/p' },
    ])
  })
})

describe('urlsChangedSince', () => {
  const urls = [
    { loc: 'https://x.com/old', lastmod: '2026-10-01' },
    { loc: 'https://x.com/same-day', lastmod: '2026-11-03' },
    { loc: 'https://x.com/new', lastmod: '2026-11-04T10:00:00Z' },
    { loc: 'https://x.com/undated' },
  ]

  it('submits everything on the first run', () => {
    expect(urlsChangedSince(urls, null)).toHaveLength(4)
  })

  it('includes the boundary day and skips what it cannot date', () => {
    expect(urlsChangedSince(urls, '2026-11-03')).toEqual([
      'https://x.com/same-day',
      'https://x.com/new',
    ])
  })
})

describe('indexNowPayloads', () => {
  it('drops off-host and duplicate urls, which would 422 the whole batch', () => {
    const [payload, extra] = indexNowPayloads('https://example.com/', KEY, [
      'https://example.com/a',
      'https://example.com/a',
      'https://evil.com/b',
      'not a url',
    ])
    expect(extra).toBeUndefined()
    expect(payload).toEqual({
      host: 'example.com',
      key: KEY,
      keyLocation: 'https://example.com/indexnow-key.txt',
      urlList: ['https://example.com/a'],
    })
  })

  it('splits at the protocol ceiling', () => {
    const urls = Array.from(
      { length: INDEXNOW_MAX_URLS + 1 },
      (_, i) => `https://example.com/p/${i}`,
    )
    expect(indexNowPayloads('https://example.com', KEY, urls).map((p) => p.urlList.length)).toEqual(
      [INDEXNOW_MAX_URLS, 1],
    )
  })

  it('sends nothing when there is nothing to send', () => {
    expect(indexNowPayloads('https://example.com', KEY, [])).toEqual([])
  })
})

describe('indexNowSkipReason', () => {
  const ok = { appUrl: 'https://example.com', indexable: true, key: KEY }

  it('goes ahead on a public, indexable origin with a valid key', () => {
    expect(indexNowSkipReason(ok)).toBeNull()
  })

  it.each([
    [{ ...ok, key: '' }, 'unconfigured'],
    [{ ...ok, key: 'short' }, 'invalid-key'],
    [{ ...ok, key: 'has spaces in it' }, 'invalid-key'],
    [{ ...ok, indexable: false }, 'not-indexable'],
    [{ ...ok, appUrl: 'http://localhost:3000' }, 'not-public-origin'],
    [{ ...ok, appUrl: 'https://my-app.localhost' }, 'not-public-origin'],
    [{ ...ok, appUrl: 'http://example.com' }, 'not-public-origin'],
  ] as const)('%o → %s', (input, reason) => {
    expect(indexNowSkipReason(input)).toBe(reason)
  })

  it('validates the key alphabet and length', () => {
    expect(isValidIndexNowKey('a'.repeat(8))).toBe(true)
    expect(isValidIndexNowKey('a'.repeat(129))).toBe(false)
    expect(isValidIndexNowKey(undefined)).toBe(false)
  })
})
