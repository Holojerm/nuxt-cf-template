// Page collections: a page per row of product data, built through the SEO
// contract, and the guards that decide which rows are published. The same
// guards fail `bun run seo:check` (test/seo-source.test.ts › page collections).

import { afterEach, describe, expect, it } from 'vitest'

import { GLOSSARY } from '../shared/page-collections/glossary'
import {
  buildCollectionPage,
  checkCollectionDefinition,
  definePageCollection,
  THIN_PAGE_MIN_WORDS,
} from '../shared/utils/page-collections'
import { jaccard, publishCollections, shingles } from '../shared/utils/page-guards'
import type { ExtensionDb } from '../server/utils/extensions'
import {
  clearPageCollectionsForTest,
  getCollectionPage,
  listCollectionPages,
  registerPageCollection,
} from '../server/utils/page-collections'
import { clearPublicPagesForTest, collectPublicPages } from '../server/utils/public-pages'
import { clearPublicRoutesForTest, isPublicApiRequest } from '../server/utils/public-routes'

const OPTIONS = { origin: 'https://example.com', today: '2026-11-22' }
const DB = {} as ExtensionDb

/** Distinct prose, long enough to clear the thin-page floor on its own. */
function prose(topic: string, length = THIN_PAGE_MIN_WORDS + 10): string {
  return Array.from({ length }, (_, index) => `${topic}${index.toString(36)}`).join(' ')
}

type Thing = { slug: string; name: string; summary: string; body: string; kind?: string }

const things = definePageCollection<Thing>({
  key: 'things',
  route: '/things/[slug]',
  slug: 'slug',
  heading: 'Things',
  title: '{name} explained',
  description: '{summary}',
  h1: '{name}',
  sections: [{ heading: 'About', field: 'body' }],
  facts: [{ label: 'Kind', field: 'kind' }],
  schema: { type: 'Thing', properties: { name: 'name', description: 'body' } },
  rows: () => [],
})

const row = (slug: string, overrides: Partial<Thing> = {}): Thing => ({
  slug,
  name: `Name ${slug}`,
  summary: `A summary of ${slug} that is long enough to be a real search snippet.`,
  body: prose(slug),
  ...overrides,
})

describe('buildCollectionPage', () => {
  it('fills the templates from the row and renders only row text', () => {
    const { page, problems } = buildCollectionPage(things, row('alpha', { kind: 'Tool' }), OPTIONS)
    expect(problems).toEqual([])
    expect(page).toMatchObject({
      path: '/things/alpha',
      title: 'Name alpha explained',
      h1: 'Name alpha',
      facts: [{ label: 'Kind', value: 'Tool' }],
      breadcrumb: [{ name: 'Name alpha', path: '/things/alpha' }],
    })
    expect(page.schema).toMatchObject({
      '@type': 'Thing',
      '@id': 'https://example.com/things/alpha#things',
      name: 'Name alpha',
    })
  })

  it('refuses a thin page, and an empty field the copy needs', () => {
    const thin = buildCollectionPage(things, row('beta', { body: 'Too short.' }), OPTIONS)
    expect(thin.problems.join()).toMatch(/thin page: 2 words/)
    const unnamed = buildCollectionPage(things, row('gamma', { name: '' }), OPTIONS)
    expect(unnamed.problems.join()).toMatch(/field "name" is empty/)
  })

  it('holds titles and descriptions to the hand-written bounds', () => {
    const long = buildCollectionPage(things, row('delta', { name: 'x'.repeat(80) }), OPTIONS)
    expect(long.problems.join()).toMatch(/title is \d+ chars, max 70/)
    const short = buildCollectionPage(things, row('epsilon', { summary: 'Short.' }), OPTIONS)
    expect(short.problems.join()).toMatch(/description is 6 chars, min 50/)
  })
})

describe('checkCollectionDefinition', () => {
  it('passes the shipped glossary', () => {
    expect(checkCollectionDefinition(GLOSSARY)).toEqual([])
  })

  it('refuses invented numbers, quotes and reviews in the fixed copy', () => {
    const problems = checkCollectionDefinition({
      ...things,
      title: '{name}: rated 5 stars',
      description: '"Loved it" says {name}',
      schema: { type: 'Product', properties: { aggregateRating: 'kind' } },
    })
    expect(problems.join('\n')).toMatch(/title .* has a digit/)
    expect(problems.join('\n')).toMatch(/description .* has a quotation mark/)
    expect(problems.join('\n')).toMatch(/reviews and ratings are never generated/)
  })

  it('refuses JSON-LD about a field the page never shows, and a shared title', () => {
    const problems = checkCollectionDefinition({
      ...things,
      title: 'Things',
      schema: { type: 'Thing', properties: { name: 'summary' } },
    })
    expect(problems.join('\n')).toMatch(/title has no \{field\}/)
    expect(problems.join('\n')).toMatch(/reads "summary", which the page never shows/)
  })
})

describe('publishCollections', () => {
  it('keeps the first of two rows with the same title or description', () => {
    const { pages, rejected } = publishCollections(
      [
        {
          collection: things,
          rows: [row('one'), row('two', { name: 'Name one' }), row('three', { summary: row('one').summary })],
        },
      ],
      OPTIONS,
    )
    expect(pages.map((page) => page.path)).toEqual(['/things/one'])
    expect(rejected.map((entry) => entry.reasons.join())).toEqual([
      'title repeats /things/one',
      'description repeats /things/one',
    ])
  })

  it('refuses a near-copy: the same body with one word changed', () => {
    const body = prose('shared')
    const { pages, rejected } = publishCollections(
      [{ collection: things, rows: [row('a', { body }), row('b', { body: `${body} extra` })] }],
      OPTIONS,
    )
    expect(pages.map((page) => page.path)).toEqual(['/things/a'])
    expect(rejected[0]!.reasons).toEqual(['near-copy of /things/a'])
  })

  it('refuses a title a hand-written page already uses', () => {
    const { rejected } = publishCollections([{ collection: things, rows: [row('a')] }], {
      ...OPTIONS,
      taken: { titles: ['name A explained'] },
    })
    expect(rejected[0]!.reasons).toEqual(['title repeats a hand-written page'])
  })

  it('measures similarity on word shingles', () => {
    expect(jaccard(shingles('a b c d'), shingles('a b c d'))).toBe(1)
    expect(jaccard(shingles('a b c d'), shingles('w x y z'))).toBe(0)
  })
})

describe('the registry', () => {
  afterEach(() => {
    clearPageCollectionsForTest()
    clearPublicPagesForTest()
    clearPublicRoutesForTest()
  })

  const published = { ...things, rows: () => [row('kept'), row('thin', { body: 'Too short.' })] }

  it('publishes through the public page source: sitemap, llms.txt and the page API', async () => {
    registerPageCollection(published)
    const collected = await collectPublicPages(DB, { buildDate: '2026-11-01' })
    expect(collected.entries.map((entry) => entry.path)).toEqual(['/things/kept'])
    expect(collected.sections).toEqual([
      {
        heading: 'Things',
        links: [{ path: '/things/kept', title: 'Name kept', description: row('kept').summary }],
      },
    ])
    expect(isPublicApiRequest('/api/collection-pages/things/kept', 'GET')).toBe(true)

    const page = await getCollectionPage(DB, 'things', 'kept', 'https://example.com')
    expect(page?.schema?.url).toBe('https://example.com/things/kept')
    expect(await getCollectionPage(DB, 'things', 'thin', 'https://example.com')).toBeNull()
    expect(await listCollectionPages(DB, 'things')).toHaveLength(1)
  })

  it('marks the documents degraded when the rows cannot be read', async () => {
    registerPageCollection({
      ...published,
      rows: () => {
        throw new Error('D1 down')
      },
    })
    const collected = await collectPublicPages(DB, { buildDate: '2026-11-01' })
    expect(collected.complete).toBe(false)
    expect(collected.entries).toEqual([])
  })

  it('refuses a definition that fails its checks', () => {
    expect(() => registerPageCollection({ ...published, route: '/things' })).toThrow(/route/)
  })
})
