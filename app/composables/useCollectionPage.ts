// The page half of a page collection (shared/utils/page-collections.ts), in two
// calls a page file makes one after the other:
//
//   const page = await useCollectionPage('glossary')
//   useCollectionSeo(page)
//
// Two, not one, because of the `await`. Inside a composable an await drops the
// component instance, and useSeo() after it fails (NUXT_E1001) or registers
// head tags that outlive the page. `<script setup>` restores the instance
// around its own top-level awaits, so the SEO call has to be made from there.
//
// `bun run seo:check` counts useCollectionSeo() as the page's one useSeo() call
// and fails a page that is missing it or also calls useSeo().

import type { CollectionPageView } from '#shared/utils/page-collections'

/** The built page for this route's `[slug]`. A row the guards did not publish is a 404. */
export async function useCollectionPage(key: string): Promise<CollectionPageView> {
  const route = useRoute()
  const slug = String(route.params.slug ?? '')
  const { data } = await useFetch<CollectionPageView>(
    `/api/collection-pages/${key}/${encodeURIComponent(slug)}`,
  )
  const page = data.value
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
  return page
}

/** The same title, description, canonical, breadcrumb and JSON-LD contract as a hand-written page. */
export function useCollectionSeo(page: CollectionPageView): void {
  useSeo({
    title: page.title,
    description: page.description,
    breadcrumb: page.breadcrumb,
    schema: [page.schema],
  })
}
