// The page-collection half of `bun run seo:check`, as functions vitest can
// drive (test/page-collections.test.ts). scripts/check-seo.ts does the walk and
// the report.
//
// A generated page is held to the hand-written rules (title and description
// bounds, one useSeo(), declared public) and to the three guards: no thin page,
// no repeated title or description, no near-copy. The guards are the same
// function the Worker publishes with (shared/utils/page-guards.ts), run here
// over every static row, or over a collection's `examples` when its rows live
// in a database the gate cannot reach.

import {
  checkCollectionDefinition,
  type CollectionRow,
  collectionPrefix,
  type PageCollection,
} from '../../shared/utils/page-collections'
import { publishCollections } from '../../shared/utils/page-guards'

export interface CollectionProblem {
  file: string
  rule: string
  detail: string
  remedy: string
}

/** A page file's route, from its path under a pages dir: glossary/[slug].vue is /glossary/[slug], x/index.vue is /x. */
export function pageRouteOfFile(relativeToPages: string): string {
  const segments = relativeToPages.replace(/\.vue$/, '').split('/')
  if (segments.at(-1) === 'index') segments.pop()
  return `/${segments.join('/')}`
}

export type CollectionCall =
  | { kind: 'none' }
  | { kind: 'key'; key: string }
  | { kind: 'unreadable'; detail: string }

/** The collection a page file renders, from its `useCollectionPage('<key>')` call. */
export function collectionCall(source: string): CollectionCall {
  const calls = [...source.matchAll(/\buseCollectionPage\s*\(([^)]*)\)/g)]
  if (calls.length === 0) return { kind: 'none' }
  if (calls.length > 1) return { kind: 'unreadable', detail: `called ${calls.length} times` }
  const key = /^\s*(['"])([a-z][a-z0-9-]*)\1\s*$/.exec(calls[0]![1] ?? '')?.[2]
  return key
    ? { kind: 'key', key }
    : { kind: 'unreadable', detail: 'the key is not a string literal' }
}

export interface CollectionPageFile {
  file: string
  route: string
  key: string
}

/** Rows the gate can build: static rows, or the declared examples. */
async function gateRows(
  collection: PageCollection,
): Promise<{ rows: readonly CollectionRow[]; from: 'rows' | 'examples' } | { error: string }> {
  if (collection.examples) return { rows: collection.examples, from: 'examples' }
  try {
    return { rows: await collection.rows(undefined), from: 'rows' }
  } catch (error) {
    return { error: String(error) }
  }
}

export async function checkPageCollections(input: {
  collections: readonly PageCollection[]
  /** Where the list is declared, for the report. */
  listFile: string
  pageFiles: CollectionPageFile[]
  taken: { titles: string[]; descriptions: string[] }
  today: string
}): Promise<CollectionProblem[]> {
  const problems: CollectionProblem[] = []
  const report = (file: string, rule: string, detail: string, remedy: string) =>
    problems.push({ file, rule, detail, remedy })
  const keys = new Map<string, PageCollection>()
  const prefixes = new Map<string, string>()
  const buildable: { collection: PageCollection; rows: readonly CollectionRow[] }[] = []

  for (const collection of input.collections) {
    const where = `${input.listFile} › ${collection.key}`
    for (const problem of checkCollectionDefinition(collection)) {
      report(
        where,
        'collection definition',
        problem,
        'fix the definition; the Worker refuses it too',
      )
    }
    if (keys.has(collection.key)) {
      report(where, 'duplicate collection key', collection.key, 'give each collection its own key')
    }
    keys.set(collection.key, collection)
    const prefix = collectionPrefix(collection)
    const owner = prefixes.get(prefix)
    if (owner)
      report(where, 'shared route prefix', `${prefix} is also ${owner}'s`, 'one route each')
    prefixes.set(prefix, collection.key)

    const pages = input.pageFiles.filter((page) => page.key === collection.key)
    if (pages.length === 0) {
      report(
        where,
        'collection without a page',
        `no page file calls useCollectionPage('${collection.key}')`,
        `add app/pages${collection.route}.vue (or in a layer) that calls it`,
      )
    }
    for (const page of pages) {
      if (page.route !== collection.route) {
        report(
          page.file,
          'collection page at the wrong route',
          `${page.route}, but ${collection.key} declares ${collection.route}`,
          'move the file, or change the route in the definition',
        )
      }
    }

    const rows = await gateRows(collection)
    if ('error' in rows) {
      report(
        where,
        'rows need a database',
        rows.error,
        'add `examples`: a few real rows the gate can build without D1',
      )
      continue
    }
    if (rows.rows.length === 0) {
      report(
        where,
        `collection has no ${rows.from}`,
        'it would publish no pages, and its index page would be empty',
        rows.from === 'examples' ? 'add example rows' : 'add rows, or remove the collection',
      )
    }
    buildable.push({ collection, rows: rows.rows })
  }

  for (const page of input.pageFiles) {
    if (!keys.has(page.key)) {
      report(
        page.file,
        'unknown collection',
        `useCollectionPage('${page.key}') names no collection in ${input.listFile}`,
        'declare the collection there, or fix the key',
      )
    }
  }

  const { rejected } = publishCollections(buildable, {
    origin: '',
    today: input.today,
    taken: input.taken,
  })
  for (const row of rejected) {
    report(
      `${input.listFile} › ${row.key}`,
      'row not publishable',
      `${row.path}: ${row.reasons.join('; ')}`,
      'fix the row from the product data; never pad it with filler to pass',
    )
  }
  return problems
}
