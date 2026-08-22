// GET /api/blog/:slug — one post, including its parsed body.
//
// Public, like the list route. The body is the MDC AST that
// `<ContentRenderer>` walks — markdown is parsed at build time, so nothing
// here compiles anything at request time.

import { z } from 'zod'
import { queryCollection } from '@nuxt/content/nitro'

import { isPostVisible } from '#shared/utils/blog'

/**
 * The slug, constrained to what a filename in content/blog/ can produce.
 *
 * Not decoration. Content's query builder interpolates values into the SQL
 * string it sends (it escapes quotes, but it does not bind parameters), so the
 * slug reaches a WHERE clause as text. Validating the shape here means the only
 * thing that ever gets there is `[a-z0-9-]`, which is also exactly what a
 * lowercase markdown filename yields.
 */
const paramsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'not a post slug'),
})

export default defineEventHandler(async (event) => {
  const { slug } = await getValidatedRouterParams(event, paramsSchema.parse)

  const post = await queryCollection(event, 'blog').path(`/blog/${slug}`).first()

  // A draft is a 404 in production and readable in dev — one rule, stated once,
  // in shared/utils/blog.ts. `import.meta.dev` is a compile-time constant, so a
  // production bundle contains the strict branch and nothing else.
  if (!post || !isPostVisible(post, import.meta.dev)) {
    throw createError({ statusCode: 404, message: 'Post not found' })
  }

  // Five minutes, to browsers and to any shared cache that sees it (`max-age`
  // binds both; there is no `s-maxage` because there is no reason to split
  // them). Cloudflare's edge does not cache an /api/ path without a cache rule,
  // so in practice this is the reader's own browser — enough to make a
  // back-button return instant, short enough that publishing a fix is visible.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')

  return post
})
