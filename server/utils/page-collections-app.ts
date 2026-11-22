// This product's page collections — the app owns this file (app-owned.json).
//
// server/plugins/page-collections.ts registers every entry and
// `bun run seo:check` builds every entry, so this list is the one place a
// collection is declared. Import a fork layer's collection by relative path
// (the gate loads this file outside Nuxt), and give it a page file at its
// `route` that calls `useCollectionPage('<key>')`. See .claude/docs/seo.md ›
// Page collections.

import type { CollectionRow, PageCollection } from '../../shared/utils/page-collections'
import { GLOSSARY } from '../../shared/page-collections/glossary'

import type { ExtensionDb } from './extensions'

export const APP_PAGE_COLLECTIONS: readonly PageCollection<CollectionRow, ExtensionDb>[] = [
  GLOSSARY,
]
