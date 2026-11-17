// /.well-known/ai-catalog.json — what the app tells a client that knows only
// its domain. The route is thin; the decisions are here.

import { describe, expect, it } from 'vitest'

import { buildAiCatalog, SERVER_CARD_TYPE } from '../server/utils/ai-catalog'

describe('buildAiCatalog', () => {
  it('links to the Server Card on the MCP worker, anchored to the app’s domain', () => {
    expect(
      buildAiCatalog({
        appUrl: 'https://notes.example',
        mcpUrl: 'https://mcp.notes.example/',
        slug: 'notes',
      }),
    ).toEqual({
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:notes.example:mcp:notes',
          type: SERVER_CARD_TYPE,
          url: 'https://mcp.notes.example/mcp/server-card',
        },
      ],
    })
  })

  it('is absent, not empty, when no MCP server is configured', () => {
    expect(
      buildAiCatalog({ appUrl: 'https://notes.example', mcpUrl: '', slug: 'notes' }),
    ).toBeNull()
  })

  it('is absent when there is no origin to anchor the identifier to', () => {
    expect(
      buildAiCatalog({ appUrl: '', mcpUrl: 'https://mcp.notes.example', slug: 'n' }),
    ).toBeNull()
  })
})
