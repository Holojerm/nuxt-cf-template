// GET /.well-known/ai-catalog.json
//
// Where an MCP client looks when all it has is this site's domain. One entry,
// pointing at the Server Card on the MCP worker; see server/utils/ai-catalog.ts.
//
// 404 until NUXT_PUBLIC_MCP_URL is set, so a fork that never deployed the
// worker advertises nothing, and on preview deploys for the same reason
// llms.txt is: a preview must not be discoverable as the product.
//
// `Access-Control-Allow-Origin: *` because browser-based clients read it, and
// it is public, read-only metadata.

import manifest from '../../../fleet.json'
import { AI_CATALOG_TYPE, buildAiCatalog } from '../../utils/ai-catalog'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()

  const catalog =
    config.public.indexable === false
      ? null
      : buildAiCatalog({
          appUrl: config.public.appUrl,
          mcpUrl: config.public.mcpUrl,
          slug: manifest.slug,
        })

  if (!catalog) {
    setResponseStatus(event, 404)
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return 'Not found\n'
  }

  setResponseHeader(event, 'Content-Type', AI_CATALOG_TYPE)
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return JSON.stringify(catalog, null, 2)
})
