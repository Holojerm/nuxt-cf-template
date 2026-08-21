<script setup lang="ts">
// What shipped, newest first. Content lives in app/utils/changelog.ts.
//
// Public and indexable: this is the one page on a SaaS site that legitimately
// changes every week, which makes it worth far more to crawlers and answer
// engines than another evergreen marketing page. The `publicPage` declaration
// below is what puts it in BOTH sitemap.xml and llms.txt — there is no list to
// update anywhere else.

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.6',
    title: 'Changelog',
    summary:
      'A dated, newest-first record of what has been added, improved, and fixed in the product.',
  },
})

const config = useRuntimeConfig()
const entries = CHANGELOG

useSeo({
  title: 'Changelog',
  description: `Everything that has changed in ${config.public.appName}, newest first.`,
})
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-10 py-12">
    <header class="flex flex-col gap-3">
      <h1 class="text-3xl text-highlighted sm:text-4xl">Changelog</h1>
      <p class="text-muted">
        Everything that's changed in {{ config.public.appName }}, newest first. Something here
        because you asked for it? That happens — the feedback button is on every page.
      </p>
    </header>

    <!-- One <section> per release so each entry is its own landmark-free but
         well-labelled block; the <h2> is the accessible name for each. -->
    <section v-for="entry in entries" :key="entry.date" class="flex flex-col gap-4">
      <div class="flex flex-wrap items-baseline gap-3 border-b border-default pb-3">
        <h2 class="text-xl text-highlighted">
          <time :datetime="entry.date">{{ formatChangelogDate(entry.date) }}</time>
        </h2>
        <UBadge v-if="entry.version" color="neutral" variant="subtle" size="sm">
          {{ entry.version }}
        </UBadge>
      </div>

      <ul class="flex flex-col gap-3">
        <li v-for="(change, index) in entry.changes" :key="index" class="flex items-start gap-3">
          <UBadge
            :color="CHANGE_KIND_COLOR[change.kind]"
            variant="subtle"
            size="sm"
            class="mt-0.5 shrink-0 capitalize"
          >
            {{ change.kind }}
          </UBadge>
          <span class="text-default">{{ change.text }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
