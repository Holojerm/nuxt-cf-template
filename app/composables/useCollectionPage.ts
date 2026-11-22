// The page half of a page collection (shared/utils/page-collections.ts): fetch
// the built page for this route's `[slug]` and hand it to `useSeo()`.
//
// It calls `useSeo()` itself, once, so every generated page carries the same
// title, description, canonical, breadcrumb and JSON-LD contract as a
// hand-written one. `bun run seo:check` counts this call as the page's
// `useSeo()` and fails a page that makes both. A row the guards did not publish
// is a 404, on the server render and on a client navigation alike.

import { withAsyncContext } from 'vue'

import type { CollectionPageView } from '#shared/utils/page-collections'

export async function useCollectionPage(key: string): Promise<CollectionPageView> {
  const route = useRoute()
  const slug = String(route.params.slug ?? '')

  // An `await` in a composable drops the component instance, and with it the
  // Nuxt context useSeo() needs (NUXT_E1001). `<script setup>` restores it
  // around each top-level await by compiling to withAsyncContext(); this does
  // the same, so useSeo() below runs as if called from the page itself and its
  // head entries are removed when the page unmounts.
  const [request, restore] = withAsyncContext(() =>
    useFetch<CollectionPageView>(`/api/collection-pages/${key}/${encodeURIComponent(slug)}`),
  )
  const { data } = await request
  restore()
  const page = data.value
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })

  useSeo({
    title: page.title,
    description: page.description,
    breadcrumb: page.breadcrumb,
    schema: [page.schema],
  })
  return page
}
