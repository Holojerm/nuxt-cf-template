<script setup lang="ts">
// One glossary term, generated from its row (shared/page-collections/glossary.ts).
//
// The `publicPage` block is inert as a sitemap entry, as on /blog/[slug]: the
// route is one pattern, and the real URLs come from the collection's public
// page source. It is here because `seo:check` holds every indexable page to
// declaring itself. `useCollectionPage()` is this page's one `useSeo()` call.

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.6',
    title: 'Glossary term',
    summary: 'One term. The real URLs are enumerated in sitemap.xml and llms.txt.',
  },
})

const page = await useCollectionPage('glossary')
</script>

<template>
  <CollectionPage :page="page" />
</template>
