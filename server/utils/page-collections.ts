// The Worker side of page collections (shared/utils/page-collections.ts): a
// registry, one public page source per collection, and the published set the
// page API answers from.
//
// Registration goes through the seams every other public URL uses, so nothing
// here is beside the SEO layer: each collection is a registerPublicPageSource()
// (sitemap.xml, llms.txt, and so IndexNow, which submits what the sitemap
// dates), and the page API is a public route. server/plugins/page-collections.ts
// registers the template's collections and the app's own list.

import type {
  CollectionPageView,
  CollectionRow,
  PageCollection,
} from '#shared/utils/page-collections'
import {
  buildCollectionPage,
  checkCollectionDefinition,
  collectionPrefix,
} from '#shared/utils/page-collections'
import { publishCollections, type PublishedSet } from '#shared/utils/page-guards'

import type { ExtensionDb } from './extensions'
import { logEvent } from './log'
import { registerPublicPageSource } from './public-pages'
import { registerPublicApiRoutes } from './public-routes'

export type ServerPageCollection = PageCollection<CollectionRow, ExtensionDb>

const collections = new Map<string, ServerPageCollection>()

/** Rows are read at most this often per isolate; a new row is live within it. */
const CACHE_MS = 5 * 60 * 1000
let cache: { at: number; value: Promise<CollectionsState> } | null = null

interface CollectionsState extends PublishedSet {
  /** Collections whose rows could not be read. Their pages are absent, not removed. */
  failed: Set<string>
}

export function registerPageCollection(collection: ServerPageCollection): void {
  const problems = checkCollectionDefinition(collection as PageCollection)
  if (problems.length > 0) {
    throw new Error(`page collection "${collection.key}": ${problems.join('; ')}`)
  }
  const prefix = collectionPrefix(collection)
  for (const other of collections.values()) {
    if (other.key !== collection.key && collectionPrefix(other) === prefix) {
      throw new Error(`page collections "${other.key}" and "${collection.key}" share ${prefix}`)
    }
  }
  collections.set(collection.key, collection)
  cache = null

  registerPublicApiRoutes([{ path: '/api/collection-pages/', match: 'prefix', methods: ['GET'] }])
  registerPublicPageSource({
    key: `collection:${collection.key}`,
    llmsHeading: collection.llms === false ? undefined : collection.heading,
    defaults: { changefreq: 'monthly', priority: '0.6' },
    list: async (db) => {
      const state = await publishedState(db)
      // Throwing is how a source says "degraded": the documents are served
      // no-store instead of telling crawlers these pages are gone.
      if (state.failed.has(collection.key)) throw new Error(`rows of ${collection.key} unreadable`)
      return state.pages
        .filter((page) => page.key === collection.key)
        .map((page) => ({
          path: page.path,
          title: page.h1,
          description: page.description,
          lastmod: page.lastmod ?? undefined,
        }))
    },
  })
}

export function getPageCollections(): ServerPageCollection[] {
  return [...collections.values()]
}

async function readState(db: ExtensionDb): Promise<CollectionsState> {
  const failed = new Set<string>()
  const input = await Promise.all(
    getPageCollections().map(async (collection) => {
      try {
        return { collection: collection as PageCollection, rows: await collection.rows(db) }
      } catch (error) {
        logEvent('warn', 'page_collection_rows_failed', {
          key: collection.key,
          error: String(error),
        })
        failed.add(collection.key)
        return { collection: collection as PageCollection, rows: [] }
      }
    }),
  )
  const state = publishCollections(input, { origin: '', today: today() })
  for (const row of state.rejected) {
    logEvent('info', 'page_collection_row_unpublished', { ...row, reasons: row.reasons.join('; ') })
  }
  return { ...state, failed }
}

/** The published set, shared by the sitemap, llms.txt and the page API. */
export function publishedState(db: ExtensionDb): Promise<CollectionsState> {
  const now = Date.now()
  if (!cache || now - cache.at > CACHE_MS) {
    const value = readState(db)
    cache = { at: now, value }
    // A failed read is not cached, so the next request tries again.
    value.catch(() => (cache = null))
  }
  return cache.value
}

/** One published page with its JSON-LD resolved against the site origin, or null (a 404). */
export async function getCollectionPage(
  db: ExtensionDb,
  key: string,
  slug: string,
  origin: string,
): Promise<CollectionPageView | null> {
  const collection = collections.get(key)
  if (!collection) return null
  const path = `${collectionPrefix(collection)}${slug}`
  const state = await publishedState(db)
  const found = state.pages.find((page) => page.key === key && page.path === path)
  if (!found) return null
  return buildCollectionPage(collection as PageCollection, found.row, { origin, today: today() })
    .page
}

/** The published pages of one collection, for its index page. */
export async function listCollectionPages(
  db: ExtensionDb,
  key: string,
): Promise<{ path: string; h1: string; description: string }[] | null> {
  if (!collections.has(key)) return null
  const state = await publishedState(db)
  return state.pages
    .filter((page) => page.key === key)
    .map(({ path, h1, description }) => ({ path, h1, description }))
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Test-only: forget every collection and the cached rows. */
export function clearPageCollectionsForTest(): void {
  collections.clear()
  cache = null
}
