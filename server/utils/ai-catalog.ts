// The AI Catalog this app publishes at /.well-known/ai-catalog.json.
//
// Domain-level discovery for the MCP worker: a client that knows only this
// site's domain fetches the catalog, finds the entry for the MCP server, and
// follows its `url` to the Server Card the worker serves (mcp/src/discovery.ts).
// The catalog lives here, on the domain people know, and the card lives on the
// worker; that split is the Server Card extension's own (SEP-2127).
//
// Pure, so test/ai-catalog.test.ts can drive it without a request.

import { mcpOrigin } from '#shared/utils/site'

/** The media type of an MCP Server Card, as an AI Catalog entry names it. */
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json'
export const AI_CATALOG_TYPE = 'application/ai-catalog+json'

export interface AiCatalog {
  specVersion: '1.0'
  entries: { identifier: string; type: string; url: string }[]
}

/**
 * The catalog, or null when there is nothing to advertise: no MCP URL
 * configured, or no usable origin to anchor the identifier to.
 *
 * The entry links to the card rather than embedding it. The worker builds the
 * card from its own listing, so a copy here would be a second description of
 * the server to keep in step with the first.
 */
export function buildAiCatalog(input: {
  appUrl: string
  mcpUrl: string
  slug: string
}): AiCatalog | null {
  const mcpUrl = mcpOrigin(input.mcpUrl)
  if (!mcpUrl) return null

  let publisher: string
  try {
    publisher = new URL(input.appUrl).hostname
  } catch {
    return null
  }

  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:${input.slug}`,
        type: SERVER_CARD_TYPE,
        url: `${mcpUrl}/mcp/server-card`,
      },
    ],
  }
}
