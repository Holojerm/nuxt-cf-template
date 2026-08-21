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
// Suppressed on preview deploys for the same reason robots.txt is.

import { buildLlmsTxt } from '../utils/seo'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')

  if (!config.public.appUrl || config.public.indexable === false) {
    setResponseStatus(event, 404)
    return 'Not found\n'
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return buildLlmsTxt({
    appName: config.public.appName,
    appUrl: config.public.appUrl,
    description: config.public.appDescription,
    supportEmail: config.public.supportEmail,
    legalEntity: config.public.legalEntity,
    pages: config.publicPages ?? [],
  })
})
