<script setup lang="ts">
// The default body of a generated page: the row's h1, its sections and its
// facts, nothing else. A collection that wants more (a chart, a swatch) wraps
// this or renders `page` itself, from the same fields; text that is not in the
// row belongs in neither.

import type { CollectionPageView } from '#shared/utils/page-collections'

const props = defineProps<{ page: CollectionPageView }>()

const parent = computed(() => (props.page.breadcrumb.length > 1 ? props.page.breadcrumb[0] : null))
</script>

<template>
  <article class="mx-auto flex max-w-2xl flex-col gap-8 py-12">
    <header class="flex flex-col gap-3">
      <NuxtLink v-if="parent" :to="parent.path" class="text-sm text-muted hover:text-primary">
        {{ parent.name }}
      </NuxtLink>
      <h1 class="text-3xl text-highlighted sm:text-4xl">{{ page.h1 }}</h1>
      <p class="text-lg text-toned">{{ page.description }}</p>
    </header>

    <section v-for="section in page.sections" :key="section.heading" class="flex flex-col gap-3">
      <h2 class="text-xl text-highlighted">{{ section.heading }}</h2>
      <p v-for="(paragraph, index) in section.paragraphs" :key="index" class="text-default">
        {{ paragraph }}
      </p>
      <ul v-if="section.items.length" class="list-disc space-y-1 pl-6 text-default">
        <li v-for="item in section.items" :key="item">{{ item }}</li>
      </ul>
    </section>

    <dl
      v-if="page.facts.length"
      class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-default pt-6"
    >
      <template v-for="fact in page.facts" :key="fact.label">
        <dt class="text-sm text-muted">{{ fact.label }}</dt>
        <dd class="text-sm text-default">{{ fact.value }}</dd>
      </template>
    </dl>
  </article>
</template>
