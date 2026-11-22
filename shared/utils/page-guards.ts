// Which generated pages are published. A row is left out when its own page
// fails (./page-collections.ts › buildCollectionPage), or when it would repeat
// a page already accepted: the same title, the same description, or a body
// that is a near-copy. Rows are taken in order, collection by collection, so
// the first of two clashing rows is the one kept and the result is stable.
//
// The same function runs in the Worker, where a rejected row is a 404 and is
// absent from sitemap.xml and llms.txt, and in `bun run seo:check`, where it
// fails the build. Pure and alias-free for that reason.

import {
  buildCollectionPage,
  bodyText,
  type CollectionPageView,
  type CollectionRow,
  type PageCollection,
  words,
} from './page-collections'

/**
 * Two bodies sharing this share of their word 3-shingles (Jaccard) are one page
 * twice. Row text that differs only in a name or a number lands well above it.
 */
export const NEAR_COPY_SIMILARITY = 0.8

export interface RejectedRow {
  key: string
  path: string
  reasons: string[]
}

export interface PublishedSet {
  pages: (CollectionPageView & { row: CollectionRow })[]
  rejected: RejectedRow[]
}

/** Lowercased with whitespace collapsed: "A  Title" and "a title" are one title. */
function normal(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Word 3-shingles as a set (one-word and two-word texts shingle whole). */
export function shingles(text: string): Set<string> {
  const list = words(text)
  if (list.length < 3) return new Set(list.length ? [list.join(' ')] : [])
  const out = new Set<string>()
  for (let index = 0; index + 3 <= list.length; index++) {
    out.add(`${list[index]} ${list[index + 1]} ${list[index + 2]}`)
  }
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Build every row of every collection and decide what is published. `taken`
 * holds titles and descriptions already used elsewhere on the site (the gate
 * passes the hand-written pages'), so a generated page cannot repeat one.
 */
export function publishCollections(
  input: { collection: PageCollection; rows: readonly CollectionRow[] }[],
  options: {
    origin: string
    today: string
    taken?: { titles?: string[]; descriptions?: string[] }
  },
): PublishedSet {
  const pages: PublishedSet['pages'] = []
  const rejected: RejectedRow[] = []
  const paths = new Map<string, string>()
  const titles = new Map<string, string>(
    (options.taken?.titles ?? []).map((title) => [normal(title), 'a hand-written page']),
  )
  const descriptions = new Map<string, string>(
    (options.taken?.descriptions ?? []).map((text) => [normal(text), 'a hand-written page']),
  )
  const bodies: { path: string; shingles: Set<string> }[] = []

  for (const { collection, rows } of input) {
    for (const row of rows) {
      const { page, problems } = buildCollectionPage(collection, row, options)
      const reasons = [...problems]

      const samePath = paths.get(page.path)
      if (samePath) reasons.push(`path repeats ${samePath}`)
      const sameTitle = titles.get(normal(page.title))
      if (sameTitle) reasons.push(`title repeats ${sameTitle}`)
      const sameDescription = descriptions.get(normal(page.description))
      if (sameDescription) reasons.push(`description repeats ${sameDescription}`)

      const own = shingles(bodyText(page))
      // Jaccard can only reach the line when the smaller set is at least that
      // share of the larger, so most pairs are skipped on size alone.
      const copy = bodies.find(
        (other) =>
          Math.min(own.size, other.shingles.size) >=
            NEAR_COPY_SIMILARITY * Math.max(own.size, other.shingles.size) &&
          jaccard(own, other.shingles) >= NEAR_COPY_SIMILARITY,
      )
      if (copy) reasons.push(`near-copy of ${copy.path}`)

      if (reasons.length > 0) {
        rejected.push({ key: collection.key, path: page.path, reasons })
        continue
      }
      paths.set(page.path, page.path)
      titles.set(normal(page.title), page.path)
      descriptions.set(normal(page.description), page.path)
      bodies.push({ path: page.path, shingles: own })
      pages.push({ ...page, row })
    }
  }
  return { pages, rejected }
}
