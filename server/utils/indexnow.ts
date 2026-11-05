// IndexNow: tell Bing (and Yandex, Naver, Seznam, which share submissions) which
// URLs changed, instead of waiting for the next crawl. Bing's index also feeds
// ChatGPT search, Copilot and DuckDuckGo, so this is the cheapest lever on
// answer-engine freshness there is. Google does not take part; its sitemap
// `<lastmod>` is the equivalent signal.
//
// The URL list is read back out of this app's own /sitemap.xml rather than
// rebuilt here. Forks customise the sitemap route (per-row lastmods, data-driven
// pages); parsing what it actually serves means the ping can never disagree with
// it, and no fork has to port anything.
//
// Everything below is pure so it is testable in the workerd pool; the scheduled
// task in server/tasks/seo/indexnow.ts does the I/O.

import { normalizeOrigin } from '#shared/utils/site'

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
/** Served by server/routes/indexnow-key.txt.get.ts. At the root, so it covers every path. */
export const INDEXNOW_KEY_PATH = '/indexnow-key.txt'
/** The protocol's per-request ceiling. */
export const INDEXNOW_MAX_URLS = 10_000
/** KV key holding the `YYYY-MM-DD` of the last accepted submission. */
export const INDEXNOW_STATE_KEY = 'seo:indexnow:last-submitted'

const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/

export function isValidIndexNowKey(key: string | undefined): key is string {
  return !!key && KEY_PATTERN.test(key)
}

export interface SitemapUrl {
  loc: string
  lastmod?: string
}

/**
 * `<loc>`/`<lastmod>` pairs from a sitemap this app generated. A regex, not an
 * XML parser: the input is our own buildSitemap() output, one `<url>` block per
 * entry, escaped by escapeXml().
 */
export function parseSitemapUrls(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = []
  for (const [, block = ''] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]
    if (!loc) continue
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]
    urls.push({ loc: unescapeXml(loc.trim()), ...(lastmod ? { lastmod: lastmod.trim() } : {}) })
  }
  return urls
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * URLs whose lastmod is on or after `since` (both `YYYY-MM-DD`, so string order
 * is date order). The boundary day is included because a page can change after
 * the previous run on the same day; resubmitting an unchanged URL is harmless.
 * No `since` (first run) submits everything. A URL with no lastmod cannot be
 * dated, so after the first run it waits for the crawler like before.
 */
export function urlsChangedSince(urls: SitemapUrl[], since: string | null): string[] {
  if (!since) return urls.map((u) => u.loc)
  return urls.filter((u) => u.lastmod && u.lastmod.slice(0, 10) >= since).map((u) => u.loc)
}

export interface IndexNowPayload {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

/**
 * One request body per 10,000 URLs. URLs on another host are dropped: the
 * endpoint answers 422 for the whole batch if any URL is off-host.
 */
export function indexNowPayloads(appUrl: string, key: string, urls: string[]): IndexNowPayload[] {
  const origin = normalizeOrigin(appUrl)
  const host = new URL(origin).host
  const own = [...new Set(urls)].filter((u) => {
    try {
      return new URL(u).host === host
    } catch {
      return false
    }
  })
  const payloads: IndexNowPayload[] = []
  for (let i = 0; i < own.length; i += INDEXNOW_MAX_URLS) {
    payloads.push({
      host,
      key,
      keyLocation: `${origin}${INDEXNOW_KEY_PATH}`,
      urlList: own.slice(i, i + INDEXNOW_MAX_URLS),
    })
  }
  return payloads
}

/**
 * Why a submission would be pointless, or null when it can go ahead. A preview
 * deploy or a localhost origin must never ping: the endpoint would fetch a key
 * file that is not public and flag the key.
 */
export function indexNowSkipReason(input: {
  appUrl: string
  indexable: boolean
  key: string | undefined
}): 'unconfigured' | 'invalid-key' | 'not-indexable' | 'not-public-origin' | null {
  if (!input.key) return 'unconfigured'
  if (!isValidIndexNowKey(input.key)) return 'invalid-key'
  if (!input.indexable) return 'not-indexable'
  const origin = normalizeOrigin(input.appUrl)
  if (!origin.startsWith('https://') || /\/\/(localhost|127\.|\[::1\])|\.localhost$/.test(origin)) {
    return 'not-public-origin'
  }
  return null
}
