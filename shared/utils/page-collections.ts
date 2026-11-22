// Page collections: one public page per row of data the product already owns
// (a catalogue, scenarios, rules, glossary entries), built through the same SEO
// contract as a hand-written page.
//
// A collection is declarative on purpose. Its fixed copy (title and description
// templates, section headings, fact labels) is written once and is the same on
// every page; everything that differs between pages is a field of the row,
// rendered as it is. That is what makes "every fact on a page comes from the
// row" a property of the code rather than a promise: there is nowhere to put a
// per-page sentence the row did not supply. The guards in ./page-guards.ts then
// decide which rows are published.
//
// Pure and alias-free, because three programs read it: the Worker (sitemap,
// llms.txt, the page API), the app (the page itself), and `bun run seo:check`,
// which imports collection definitions by relative path. A definition module
// must be alias-free for the same reason.

import { DESCRIPTION_MAX, DESCRIPTION_MIN, TITLE_MAX } from './seo-bounds'

/** What a row field may hold. Lists render as a bulleted list. */
export type FieldValue = string | number | readonly string[] | null | undefined

/** A row is a flat record. Declare row shapes as `type`, not `interface`. */
export type CollectionRow = Record<string, FieldValue>

type Field<Row> = keyof Row & string

export interface PageCollection<Row extends CollectionRow = CollectionRow, Db = unknown> {
  /** `[a-z][a-z0-9-]*`. Names the collection in the API path and in `useCollectionPage()`. */
  key: string
  /** The page file's route with one `[slug]` segment last: `/glossary/[slug]`. */
  route: string
  /** The field holding each row's URL segment, `[a-z0-9]+(-[a-z0-9]+)*`. */
  slug: Field<Row>
  /** The llms.txt section heading, and the breadcrumb name of `indexPath`. */
  heading: string
  /** A hand-written page listing the collection, for the breadcrumb. */
  indexPath?: string
  /** Also list the pages in llms.txt. Default true. */
  llms?: boolean
  /** Templates over row fields: `{term}: what it means`. Fixed copy may hold no digits or quotes. */
  title: string
  description: string
  h1: string
  /** The body, in order. A string field renders as paragraphs (split on blank lines). */
  sections: readonly { heading: string; field: Field<Row> }[]
  /** Short labelled values under the body, rendered as a definition list. */
  facts?: readonly { label: string; field: Field<Row> }[]
  /**
   * JSON-LD for the thing the page is about, where a schema.org type fits.
   * Each property names a field, and that field must be rendered on the page.
   */
  schema?: { type: string; properties: Readonly<Record<string, Field<Row>>> }
  /** A field holding `YYYY-MM-DD`: the page's `<lastmod>`, which is what IndexNow submits on. */
  lastmod?: Field<Row>
  /** Raise the thin-page floor for this collection. It cannot be lowered. */
  minWords?: number
  /**
   * Every row, in the order that decides which of two near-copies is kept (first
   * wins). Method syntax on purpose: it lets a collection typed for the Worker's
   * database sit in a list the gate reads without one.
   */
  rows(db: Db): Promise<readonly Row[]> | readonly Row[]
  /**
   * Rows `seo:check` builds when `rows` needs a database. Required then: the gate
   * cannot reach production data, so it checks the definition against these.
   */
  examples?: readonly Row[]
}

/** Typed authoring, widened for the registry. */
export function definePageCollection<Row extends CollectionRow, Db = unknown>(
  collection: PageCollection<Row, Db>,
): PageCollection<CollectionRow, Db> {
  return collection as unknown as PageCollection<CollectionRow, Db>
}

/** One page, as the app renders it. Only row text, plus the collection's fixed labels. */
export interface CollectionPageView {
  key: string
  path: string
  title: string
  description: string
  h1: string
  sections: { heading: string; paragraphs: string[]; items: string[] }[]
  facts: { label: string; value: string }[]
  breadcrumb: { name: string; path: string }[]
  lastmod: string | null
  schema: Record<string, unknown> | null
}

/** A page has at least this many words of row text, or it is not published. */
export const THIN_PAGE_MIN_WORDS = 80

/** Schema.org types and properties a collection may not emit: they are reviews and ratings. */
const FORBIDDEN_SCHEMA = /review|rating|testimonial/i

const KEY = /^[a-z][a-z0-9-]*$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROUTE = /^(?:\/[a-z0-9-]+)+\/\[slug\]$/
const PLACEHOLDER = /\{([A-Za-z_$][\w$]*)\}/g

/** The path prefix a collection's pages share: `/glossary/[slug]` gives `/glossary/`. */
export function collectionPrefix(collection: Pick<PageCollection, 'route'>): string {
  return collection.route.replace(/\[slug\]$/, '')
}

/** Fields named by `{placeholders}` in a template. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

/** Fields whose text appears on the page: what JSON-LD may describe. */
function renderedFields(collection: PageCollection): Set<string> {
  return new Set([
    ...placeholders(collection.h1),
    ...collection.sections.map((section) => section.field),
    ...(collection.facts ?? []).map((fact) => fact.field),
  ])
}

/**
 * What is wrong with a collection as declared, before any row is read. A
 * non-empty answer means the collection is refused at registration and fails
 * `seo:check`.
 */
export function checkCollectionDefinition(collection: PageCollection): string[] {
  const problems: string[] = []
  if (!KEY.test(collection.key)) problems.push(`key "${collection.key}" is not [a-z][a-z0-9-]*`)
  if (!ROUTE.test(collection.route)) {
    problems.push(`route "${collection.route}" is not /<segments>/[slug]`)
  }
  if (collection.sections.length === 0) problems.push('no sections: a page needs a body')
  if ((collection.minWords ?? THIN_PAGE_MIN_WORDS) < THIN_PAGE_MIN_WORDS) {
    problems.push(`minWords ${collection.minWords} is under the floor of ${THIN_PAGE_MIN_WORDS}`)
  }

  // Fixed copy is the same on every page, so a number or a quotation in it was
  // written by hand rather than taken from a row: invented by definition.
  const fixed = [
    ['title', collection.title.replace(PLACEHOLDER, '')],
    ['description', collection.description.replace(PLACEHOLDER, '')],
    ['h1', collection.h1.replace(PLACEHOLDER, '')],
    ['heading', collection.heading],
    ...collection.sections.map((section) => ['section heading', section.heading]),
    ...(collection.facts ?? []).map((fact) => ['fact label', fact.label]),
  ]
  for (const [where, text] of fixed) {
    if (/\d/.test(text!)) problems.push(`${where} "${text}" has a digit: numbers come from rows`)
    if (/["“”«»]/.test(text!)) problems.push(`${where} "${text}" has a quotation mark`)
  }
  if (placeholders(collection.title).length === 0) {
    problems.push('title has no {field}: every page would share it')
  }
  if (placeholders(collection.description).length === 0) {
    problems.push('description has no {field}: every page would share it')
  }

  if (collection.schema) {
    const { type, properties } = collection.schema
    if (!/^[A-Z][A-Za-z]+$/.test(type)) problems.push(`schema type "${type}" is not a type name`)
    const rendered = renderedFields(collection)
    for (const [property, field] of Object.entries(properties)) {
      if (FORBIDDEN_SCHEMA.test(property) || FORBIDDEN_SCHEMA.test(type)) {
        problems.push(`schema ${type}.${property}: reviews and ratings are never generated`)
      }
      if (!rendered.has(field)) {
        problems.push(`schema property ${property} reads "${field}", which the page never shows`)
      }
    }
  }
  return problems
}

/** A field as display text, or '' when it is empty. */
function isList(value: FieldValue): value is readonly string[] {
  return typeof value === 'object' && value !== null
}

export function fieldText(value: FieldValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'string') return value.trim()
  return value
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ')
}

function fill(template: string, row: CollectionRow, missing: Set<string>): string {
  return template
    .replace(PLACEHOLDER, (_, field: string) => {
      const text = fieldText(row[field])
      if (!text) missing.add(field)
      return text
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Words in a text, counted the same way for every language this app may serve. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
}

/** The row text a page shows in its body: what the thin and near-copy guards measure. */
export function bodyText(page: Pick<CollectionPageView, 'sections' | 'facts'>): string {
  return [
    ...page.sections.flatMap((section) => [...section.paragraphs, ...section.items]),
    ...page.facts.map((fact) => fact.value),
  ].join(' ')
}

export interface BuiltPage {
  page: CollectionPageView
  /** Why this row cannot be published on its own. Empty means it may be. */
  problems: string[]
}

/**
 * One row as a page, and what stops it being published by itself. The set-level
 * guards (duplicates, near-copies) are ./page-guards.ts. `origin` is only for
 * the JSON-LD `@id` and `url`; pass '' when listing.
 */
export function buildCollectionPage(
  collection: PageCollection,
  row: CollectionRow,
  options: { origin: string; today: string },
): BuiltPage {
  const problems: string[] = []
  const missing = new Set<string>()
  const slug = fieldText(row[collection.slug])
  if (!SLUG.test(slug)) problems.push(`slug "${slug}" is not [a-z0-9]+(-[a-z0-9]+)*`)
  const path = `${collectionPrefix(collection)}${slug}`

  const title = fill(collection.title, row, missing)
  const description = fill(collection.description, row, missing)
  const h1 = fill(collection.h1, row, missing)

  type Section = CollectionPageView['sections'][number]
  const sections = collection.sections.flatMap(({ heading, field }): Section[] => {
    const value = row[field]
    if (isList(value)) {
      const items = value.map((item) => item.trim()).filter(Boolean)
      return items.length ? [{ heading, paragraphs: [], items }] : []
    }
    const paragraphs = fieldText(value)
      .split(/\n\s*\n/)
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    return paragraphs.length ? [{ heading, paragraphs, items: [] }] : []
  })
  const facts = (collection.facts ?? []).flatMap(({ label, field }) => {
    const value = fieldText(row[field])
    return value ? [{ label, value }] : []
  })

  for (const field of missing) problems.push(`field "${field}" is empty but the copy needs it`)
  if (title.length > TITLE_MAX) problems.push(`title is ${title.length} chars, max ${TITLE_MAX}`)
  if (description.length < DESCRIPTION_MIN) {
    problems.push(`description is ${description.length} chars, min ${DESCRIPTION_MIN}`)
  }
  if (description.length > DESCRIPTION_MAX) {
    problems.push(`description is ${description.length} chars, max ${DESCRIPTION_MAX}`)
  }
  const minWords = Math.max(THIN_PAGE_MIN_WORDS, collection.minWords ?? 0)
  const count = words(bodyText({ sections, facts })).length
  if (count < minWords) problems.push(`thin page: ${count} words of row text, min ${minWords}`)

  let lastmod: string | null = null
  if (collection.lastmod) {
    const value = fieldText(row[collection.lastmod])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`lastmod "${value}" is not YYYY-MM-DD`)
    else if (value > options.today) problems.push(`lastmod ${value} is in the future`)
    else lastmod = value
  }

  const breadcrumb = [
    ...(collection.indexPath ? [{ name: collection.heading, path: collection.indexPath }] : []),
    { name: h1, path },
  ]

  let schema: CollectionPageView['schema'] = null
  if (collection.schema) {
    const url = `${options.origin}${path}`
    const properties = Object.entries(collection.schema.properties).flatMap(
      ([key, field]): [string, unknown][] => {
        const value = row[field]
        if (isList(value)) return value.length ? [[key, [...value]]] : []
        const text = fieldText(value)
        return text ? [[key, typeof value === 'number' ? value : text]] : []
      },
    )
    schema = {
      '@type': collection.schema.type,
      '@id': `${url}#${collection.key}`,
      url,
      ...Object.fromEntries(properties),
    }
  }

  return {
    page: {
      key: collection.key,
      path,
      title,
      description,
      h1,
      sections,
      facts,
      breadcrumb,
      lastmod,
      schema,
    },
    problems,
  }
}
