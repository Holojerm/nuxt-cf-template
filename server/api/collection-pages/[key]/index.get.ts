// GET /api/collection-pages/:key — the published pages of one collection, for
// its index page. Only what the guards published; public like the pages.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { listCollectionPages } from '../../../utils/page-collections'

const paramsSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]*$/) })

export default defineEventHandler(async (event) => {
  const params = paramsSchema.safeParse(getRouterParams(event))
  if (!params.success) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const pages = await listCollectionPages(db, params.data.key)
  if (!pages) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return pages
})
