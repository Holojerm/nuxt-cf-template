<script setup lang="ts">
// The glossary index: every published term, linked. A generated page nothing
// links to is found only through the sitemap, so each collection worth
// publishing has a page like this one.

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.5',
    title: 'Glossary',
    summary: 'The terms this product uses, each with a page of its own.',
  },
})

const { data: terms } = await useFetch('/api/collection-pages/glossary')

useSeo({
  title: 'Glossary',
  description:
    'The words this product uses for how it works, from signing in to your data, each defined on a page of its own.',
  breadcrumb: [{ name: 'Glossary', path: '/glossary' }],
})
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-10 py-12">
    <header class="flex flex-col gap-3">
      <h1 class="text-3xl text-highlighted sm:text-4xl">Glossary</h1>
      <p class="text-muted">The words this product uses, each defined on a page of its own.</p>
    </header>

    <ul v-if="terms?.length" class="flex flex-col">
      <li v-for="term in terms" :key="term.path" class="border-b border-default py-4 first:pt-0">
        <h2 class="text-lg text-highlighted">
          <NuxtLink :to="term.path" class="hover:text-primary">{{ term.h1 }}</NuxtLink>
        </h2>
        <p class="text-default">{{ term.description }}</p>
      </li>
    </ul>
  </div>
</template>
