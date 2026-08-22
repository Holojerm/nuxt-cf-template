<script setup lang="ts">
// One blog post. The markdown is content/blog/<slug>.md, parsed at build time
// and served from D1 by GET /api/blog/:slug.
//
// ── About the `publicPage` block below ───────────────────────────────────────
// It is INERT as a sitemap entry, and that is expected. The `pages:resolved`
// hook in nuxt.config.ts deliberately skips any route whose path contains `:`,
// because `/blog/:slug()` is one pattern rather than N URLs — the real per-post
// entries are built in server/routes/sitemap.xml.get.ts, which queries the
// collection and knows each post's own `lastmod`.
//
// It is here because `bun run seo:check` enforces a single invariant across
// every page: indexable ⇔ declared public. A dynamic page is genuinely
// indexable, so it declares itself; dropping the rule for dynamic pages would
// mean the next one added quietly reaches neither file. The values stay
// literal for the reason the index page documents.

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.5',
    title: 'Blog post',
    summary: 'An individual post. The real URLs are enumerated in sitemap.xml and llms.txt.',
  },
})

const route = useRoute()
const site = useSiteContext()

// Encoded, even though the server only ever answers for `[a-z0-9-]`: the value
// here is whatever was in the address bar, and an unencoded `?` or `#` would
// silently truncate the request path into a URL that resolves to a different
// route rather than to the 404 the reader should get.
const { data: post } = await useFetch(
  () => `/api/blog/${encodeURIComponent(String(route.params.slug ?? ''))}`,
)

// A missing slug is a 404, not an empty page. `fatal` so it renders the error
// page on a client-side navigation too, not just on the server render.
if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found', fatal: true })
}

const published = computed(() => post.value?.date ?? '')
const updated = computed(() => post.value?.updated || undefined)

useSeo({
  title: post.value.title,
  // Not a literal, and `seo:check` knows it: on a dynamic page the description
  // is per-record data. The length contract moves to the frontmatter, which
  // that same gate reads straight out of content/blog/*.md.
  description: post.value.description,
  ogType: 'article',
  breadcrumb: [
    { name: 'Blog', path: '/blog' },
    { name: post.value.title, path: route.path },
  ],
  schema: [
    blogPostingSchema(site, {
      url: absoluteUrl(site.appUrl, route.path),
      title: post.value.title,
      description: post.value.description,
      datePublished: post.value.date,
      dateModified: post.value.updated || undefined,
      author: post.value.author,
    }),
  ],
})
</script>

<template>
  <article v-if="post" class="mx-auto flex max-w-2xl flex-col py-12">
    <header class="flex flex-col gap-3">
      <h1 class="text-3xl text-highlighted sm:text-4xl">{{ post.title }}</h1>
      <!-- The separators are decorative: read aloud, "18 June 2026 · My Company
           Ltd" should be three facts, not two middots. -->
      <p class="text-sm text-muted">
        <time :datetime="published">{{ formatLongDate(published) }}</time>
        <span aria-hidden="true"> · </span>
        <span>{{ post.author }}</span>
        <template v-if="updated">
          <span aria-hidden="true"> · </span>
          <span>Updated {{ formatLongDate(updated) }}</span>
        </template>
      </p>
    </header>

    <!-- Rendered from the parsed AST, not from markdown at request time. The
         Prose* components come from NuxtUI (registered because @nuxt/content is
         installed), so headings, lists, and inline code already resolve through
         the DESIGN.md token layer — see app/app.config.ts for the two defaults
         this system overrides. -->
    <ContentRenderer :value="post" class="mt-8 border-t border-default pt-2" />

    <footer class="mt-12 border-t border-default pt-6">
      <UButton to="/blog" color="neutral" variant="outline" icon="i-lucide-arrow-left">
        All posts
      </UButton>
    </footer>
  </article>
</template>
