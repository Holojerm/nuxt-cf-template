<script setup lang="ts">
// The post index. Content lives in content/blog/*.md; this page only lists it.
//
// The `publicPage` declaration below is what puts /blog into sitemap.xml and
// llms.txt. The posts themselves cannot get there this way — they have no
// route-table entry of their own — so server/routes/sitemap.xml.get.ts queries
// the collection and appends them. See app/pages/blog/[slug].vue.
//
// Every value in `publicPage` is a LITERAL on purpose. Nuxt extracts this key
// statically at build time (nuxt.config.ts › experimental.extraPageMetaExtraction
// Keys), and an interpolated string fails its serializability check and is
// dropped — producing an empty sitemap rather than an error.

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.6',
    title: 'Blog',
    summary:
      'Long-form posts about how this template works: the billing model, the sign-in design, and the decisions behind what it does not ship.',
  },
})

const config = useRuntimeConfig()

// Server-side query, fetched over the API. Content's app-side queryCollection()
// would run SQLite in WebAssembly in the browser on client-side navigation —
// see server/utils/blog.ts.
const { data: posts } = await useFetch('/api/blog')

useSeo({
  title: 'Blog',
  description:
    'Notes on building and running a SaaS on Cloudflare Workers — billing, sign-in, and the trade-offs behind what this template ships.',
  breadcrumb: [{ name: 'Blog', path: '/blog' }],
})
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-10 py-12">
    <header class="flex flex-col gap-3">
      <h1 class="text-3xl text-highlighted sm:text-4xl">Blog</h1>
      <p class="text-muted">
        How {{ config.public.appName }} works underneath — written for the person deciding whether
        to build on it.
      </p>
    </header>

    <!-- A list, not a grid of cards: these are articles to read in order, and a
         reading list is what a <ul> of headlines already is. -->
    <ul v-if="posts?.length" class="flex flex-col">
      <li v-for="post in posts" :key="post.path" class="border-b border-default py-6 first:pt-0">
        <article class="flex flex-col gap-2">
          <h2 class="text-xl text-highlighted sm:text-2xl">
            <NuxtLink :to="post.path" class="hover:text-primary">{{ post.title }}</NuxtLink>
          </h2>
          <p class="text-default">{{ post.description }}</p>
          <p class="text-sm text-muted">
            <time :datetime="post.date">{{ formatLongDate(post.date) }}</time>
            <span aria-hidden="true"> · </span>{{ post.author }}
          </p>
        </article>
      </li>
    </ul>

    <!-- DESIGN.md › Component behavior › Empty states: one line, one action. -->
    <div v-else class="flex flex-col items-start gap-4">
      <p class="text-muted">No posts yet. Add a markdown file to content/blog/ to publish one.</p>
      <UButton to="/" color="neutral" variant="outline">Back to home</UButton>
    </div>
  </div>
</template>
