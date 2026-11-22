// GET /api/collection-pages/:key/:slug — one generated page, built from its row.
//
// Public: these pages are what search finds. A row the guards left out
// (thin, duplicate, near-copy; shared/utils/page-guards.ts) is a 404 here, the
// same answer as a row that does not exist.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { normalizeOrigin } from '#shared/utils/site'

import { getCollectionPage } from '../../../utils/page-collections'

const paramsSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  slug: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
})

export default defineEventHandler(async (event) => {
  const params = paramsSchema.safeParse(getRouterParams(event))
  if (!params.success) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const origin = normalizeOrigin(useRuntimeConfig().public.appUrl)
  const page = await getCollectionPage(db, params.data.key, params.data.slug, origin)
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return page
})
