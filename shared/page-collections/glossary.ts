// The glossary: a page per term at /glossary/<slug>, and the worked example of
// a page collection (shared/utils/page-collections.ts). The terms are the
// app's own (./glossary-terms.ts); this file is the layout every term shares.
//
// A collection backed by D1 rows has the same shape: `rows` takes the database
// and returns plain rows, and `examples` gives `seo:check` a few to build,
// since the gate cannot reach production data.
//
// Relative imports only: `bun run seo:check` loads this file outside Nuxt.

import { definePageCollection } from '../utils/page-collections'
import { GLOSSARY_TERMS, type GlossaryTerm } from './glossary-terms'

export const GLOSSARY = definePageCollection<GlossaryTerm>({
  key: 'glossary',
  route: '/glossary/[slug]',
  slug: 'slug',
  heading: 'Glossary',
  indexPath: '/glossary',
  title: '{term}: what it means',
  description: '{summary}',
  h1: '{term}',
  sections: [
    { heading: 'What it is', field: 'definition' },
    { heading: 'How it works here', field: 'detail' },
  ],
  facts: [{ label: 'Part of', field: 'area' }],
  schema: { type: 'DefinedTerm', properties: { name: 'term', description: 'definition' } },
  lastmod: 'updated',
  rows: () => GLOSSARY_TERMS,
})
