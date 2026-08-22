// GET /llms.txt
//
// The llmstxt.org convention: one Markdown file at a fixed path that tells a
// model what this site is and which URLs are worth fetching. robots.txt says
// what a crawler *may* read; llms.txt says what is worth reading.
//
// Worth having even though nothing is obligated to fetch it. It costs one
// generated route, it is derived from the same `definePageMeta({ publicPage })`
// declarations as sitemap.xml — so it cannot drift out of date on its own — and
// the alternative is letting a model infer the shape of the product from
// whichever marketing page it happened to land on.
//
// Blog posts are appended from the content collection, for the same reason they
// are appended to sitemap.xml: they have no route-table entry to collect. They
// are also the part of this file with the most to offer an answer engine — a
// marketing page states what the product is, a post explains how it works, and
// the second is what gets quoted.
//
// Suppressed on preview deploys for the same reason robots.txt is.

import { listBlogPostsOrEmpty } from '../utils/blog'
import { buildLlmsTxt } from '../utils/seo'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')

  if (!config.public.appUrl || config.public.indexable === false) {
    setResponseStatus(event, 404)
    return 'Not found\n'
  }

  const posts = await listBlogPostsOrEmpty(event)

  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return buildLlmsTxt({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    description: config.public.appDescription,
    supportEmail: config.public.supportEmail,
    legalEntity: config.public.legalEntity,
    pages: config.publicPages ?? [],
    posts: posts.map((post) => ({
      path: post.path,
      title: post.title,
      description: post.description,
      date: post.date,
    })),
  })
})
