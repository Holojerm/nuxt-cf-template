// The MCP directory listing: what mcp/listing.json may say, what is derived
// from it for each directory, and what `bun run mcp:check` refuses.

import { describe, expect, it } from 'vitest'

import shipped from '../mcp/listing.json'
import { discoveryResponse, serverCard, type DiscoverySource } from '../mcp/src/discovery'
import {
  buildPluginManifest,
  buildPluginMcpConfig,
  buildServerJson,
  CHATGPT_NEGATIVE_CASES,
  CHATGPT_POSITIVE_CASES,
  claudeSubmission,
  listingProblems,
  McpListingSchema,
  namespaceDomain,
  readiness,
  SERVER_JSON_SCHEMA,
  type ListingContext,
  type McpListing,
} from '../scripts/lib/mcp-listing'
import type { McpTool } from '../scripts/lib/mcp-tools'

const TOOL: McpTool = {
  name: 'search_notes',
  line: 1,
  title: 'Search notes',
  description: 'Find notes by text',
  hints: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}

const LISTING: McpListing = McpListingSchema.parse({
  publish: true,
  url: 'https://mcp.notes.example',
  registry: { name: 'example.notes/notes', auth: 'dns' },
  tagline: 'Your notes in any AI client',
  summary: 'Search and read your notes from any MCP client.',
  description: 'Connects an AI client to your notes.',
  categories: ['Productivity'],
  useCases: ['Find a note by topic'],
  prerequisites: 'A Notes account.',
  links: { docs: 'https://notes.example/docs/mcp', support: 'https://notes.example/support' },
  prompts: ['Find my launch notes.'],
  testCases: {
    positive: [
      {
        description: 'Find notes by topic',
        prompt: 'Find my notes about the launch.',
        tools: ['search_notes'],
        expected: 'Returns matching notes.',
      },
    ],
    negative: [{ description: 'Unrelated', prompt: 'What is the weather?' }],
  },
})

const CTX: ListingContext = {
  listing: LISTING,
  version: '1.2.0',
  app: { slug: 'notes', name: 'Notes', url: 'https://notes.example' },
  publisher: { name: 'Notes Ltd', email: 'help@notes.example' },
  tools: [TOOL],
}

const with_ = (patch: Partial<McpListing>): ListingContext => ({
  ...CTX,
  listing: { ...LISTING, ...patch },
})

describe('McpListingSchema', () => {
  it('accepts the listing the template ships, placeholder namespace included', () => {
    expect(McpListingSchema.safeParse(shipped).success).toBe(true)
  })

  it('holds the copy to the directories’ limits', () => {
    const over = (patch: object) => McpListingSchema.safeParse({ ...shipped, ...patch }).success
    expect(over({ tagline: 'x'.repeat(31) })).toBe(false)
    expect(over({ summary: 'x'.repeat(101) })).toBe(false)
    expect(over({ description: 'x'.repeat(2001) })).toBe(false)
    expect(over({ categories: [] })).toBe(false)
  })

  it('wants an origin for `url`, not an endpoint', () => {
    const url = (value: string) => McpListingSchema.safeParse({ ...shipped, url: value }).success
    expect(url('https://mcp.notes.example')).toBe(true)
    expect(url('https://mcp.notes.example/mcp')).toBe(false)
    expect(url('http://mcp.notes.example')).toBe(false)
  })

  it('rejects a registry name the registry would, and a key it has not heard of', () => {
    const parse = (patch: object) => McpListingSchema.safeParse({ ...shipped, ...patch }).success
    expect(parse({ registry: { name: 'no-slash', auth: 'dns' } })).toBe(false)
    expect(parse({ registry: { name: 'com.example/a/b', auth: 'dns' } })).toBe(false)
    expect(parse({ sumary: 'typo' })).toBe(false)
  })
})

describe('buildServerJson', () => {
  it('is a remote-only registry entry at the worker’s /mcp', () => {
    expect(buildServerJson(CTX)).toEqual({
      $schema: SERVER_JSON_SCHEMA,
      name: 'example.notes/notes',
      title: 'Notes',
      description: 'Search and read your notes from any MCP client.',
      version: '1.2.0',
      websiteUrl: 'https://notes.example',
      icons: [
        { src: 'https://notes.example/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      ],
      remotes: [{ type: 'streamable-http', url: 'https://mcp.notes.example/mcp' }],
    })
  })

  it('says what the worker’s Server Card says, field for field', () => {
    // Two builders, one in each package; this is what keeps them one description.
    const source: DiscoverySource = {
      registryName: LISTING.registry.name,
      summary: LISTING.summary,
      version: CTX.version,
      title: CTX.app.name,
      website: CTX.app.url,
    }
    const card = serverCard(source, LISTING.url)
    const entry = buildServerJson(CTX)
    for (const key of [
      'name',
      'title',
      'description',
      'version',
      'websiteUrl',
      'icons',
      'remotes',
    ] as const) {
      expect(card[key], key).toEqual(entry[key])
    }
  })
})

describe('the worker’s discovery routes', () => {
  const SOURCE: DiscoverySource = {
    registryName: 'example.notes/notes',
    summary: 'Search and read your notes.',
    version: '1.2.0',
    title: 'Notes',
    website: 'https://notes.example',
  }
  const get = (path: string, env = {}, source = SOURCE, headers?: HeadersInit) =>
    discoveryResponse(new Request(`https://mcp.notes.example${path}`, { headers }), env, source)

  it('serves the Server Card at <endpoint>/server-card, describing the origin asked', async () => {
    const res = await get('/mcp/server-card')
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/mcp-server-card+json')
    expect(res?.headers.get('access-control-allow-origin')).toBe('*')
    const card = (await res?.json()) as ReturnType<typeof serverCard>
    expect(card.name).toBe('example.notes/notes')
    expect(card.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.notes.example/mcp' },
    ])
  })

  it('answers a repeat request with 304 when the card has not changed', async () => {
    const etag = (await get('/mcp/server-card'))?.headers.get('etag') ?? ''
    expect(etag).not.toBe('')
    const again = await get('/mcp/server-card', {}, SOURCE, { 'if-none-match': etag })
    expect(again?.status).toBe(304)
  })

  it('points the catalog at the card', async () => {
    const res = await get('/.well-known/ai-catalog.json')
    expect(res?.headers.get('content-type')).toBe('application/ai-catalog+json')
    expect(await res?.json()).toEqual({
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:mcp.notes.example:mcp:notes',
          type: 'application/mcp-server-card+json',
          url: 'https://mcp.notes.example/mcp/server-card',
        },
      ],
    })
  })

  it('advertises nothing while the registry name is the template’s placeholder', async () => {
    const placeholder = { ...SOURCE, registryName: 'io.github.YOUR_GITHUB_OWNER/my-app' }
    expect((await get('/mcp/server-card', {}, placeholder))?.status).toBe(404)
    expect((await get('/.well-known/ai-catalog.json', {}, placeholder))?.status).toBe(404)
  })

  it('serves the ChatGPT challenge token alone, and 404s without one', async () => {
    const path = '/.well-known/openai-apps-challenge'
    const res = await get(path, { OPENAI_APPS_CHALLENGE: ' tok_123 ' })
    expect(await res?.text()).toBe('tok_123')
    expect(res?.headers.get('content-type')).toContain('text/plain')
    expect((await get(path))?.status).toBe(404)
    expect((await get(path, { OPENAI_APPS_CHALLENGE: '' }))?.status).toBe(404)
  })

  it('leaves every other path, the MCP endpoint included, to the OAuth provider', async () => {
    expect(await get('/mcp')).toBeNull()
    expect(await get('/authorize')).toBeNull()
    expect(await get('/.well-known/oauth-authorization-server')).toBeNull()
  })
})

describe('namespaceDomain', () => {
  it('reverses a registry namespace back into the domain that proves it', () => {
    expect(namespaceDomain('com.example/notes')).toBe('example.com')
    expect(namespaceDomain('com.example.mcp/notes')).toBe('mcp.example.com')
  })
})

describe('listingProblems', () => {
  const ADVERTISED = 'https://mcp.notes.example'

  it('passes a complete, published listing the app also advertises', () => {
    expect(listingProblems(CTX, ADVERTISED)).toEqual([])
  })

  it('catches a test case that names a tool nobody registers', () => {
    const ctx = with_({
      testCases: {
        positive: [{ description: 'Old', prompt: 'p', tools: ['find_notes'], expected: 'e' }],
        negative: [],
      },
    })
    expect(listingProblems(ctx, ADVERTISED).map((p) => p.rule)).toEqual([
      'test case names a tool that does not exist',
    ])
  })

  it('requires the app and the listing to name one server', () => {
    expect(listingProblems(CTX, 'https://other.example').map((p) => p.rule)).toEqual([
      'NUXT_PUBLIC_MCP_URL differs from the listing',
    ])
    expect(listingProblems(CTX, 'https://mcp.notes.example/')).toEqual([])
  })

  it('refuses to publish while anything is still a placeholder', () => {
    const ctx = with_({
      url: 'https://my-app-mcp.example.workers.dev',
      registry: { name: 'io.github.YOUR_GITHUB_OWNER/my-app', auth: 'github-oidc' },
    })
    const rules = listingProblems(ctx, '').map((p) => p.rule)
    expect(rules).toContain('publish is true, but: registry.name names a real namespace')
    expect(rules).toContain('publish is true, but: url is the deployed worker')
    expect(rules).toContain('publish is true, but the app does not advertise the server')
  })

  it('leaves an unpublished, unadvertised listing alone, placeholders and all', () => {
    const ctx = with_({
      publish: false,
      url: 'https://my-app-mcp.example.workers.dev',
      registry: { name: 'io.github.YOUR_GITHUB_OWNER/my-app', auth: 'github-oidc' },
    })
    expect(listingProblems(ctx, '')).toEqual([])
  })

  it('will not let the app advertise a server whose card would 404', () => {
    const ctx = with_({
      publish: false,
      registry: { name: 'io.github.YOUR_GITHUB_OWNER/notes', auth: 'github-oidc' },
    })
    expect(listingProblems(ctx, ADVERTISED).map((p) => p.rule)).toEqual([
      'the app advertises a server with no registry name',
    ])
  })

  it('holds the auth method to the namespace it can prove', () => {
    const ctx = with_({ registry: { name: 'io.github.acme/notes', auth: 'dns' } })
    expect(listingProblems(ctx, ADVERTISED).map((p) => p.rule)).toEqual([
      'publish is true, but: registry.auth matches the namespace',
    ])
  })
})

describe('readiness', () => {
  it('counts ChatGPT’s review requirements without failing the others', () => {
    const { registry, claude, chatgpt } = readiness(CTX)
    expect(registry.every((item) => item.ok)).toBe(true)
    expect(claude.every((item) => item.ok)).toBe(true)
    expect(chatgpt.filter((item) => !item.ok).map((item) => item.label)).toEqual([
      `${CHATGPT_POSITIVE_CASES} positive test cases`,
      `${CHATGPT_NEGATIVE_CASES} negative test cases`,
      'a demo recording',
      'release notes',
    ])
  })
})

describe('the ChatGPT plugin package', () => {
  it('carries the listing, the review cases and one remote server', () => {
    const manifest = buildPluginManifest(CTX)
    const openai = manifest.extensions['com.openai']
    expect(manifest.name).toBe('notes')
    expect(manifest.version).toBe('1.2.0')
    expect(openai.interface.displayName).toBe('Notes')
    expect(openai.interface.privacyPolicyURL).toBe('https://notes.example/privacy')
    expect(openai.interface.termsOfServiceURL).toBe('https://notes.example/terms')
    expect(openai.review.test_cases.positive).toEqual([
      {
        description: 'Find notes by topic',
        prompt: 'Find my notes about the launch.',
        tools_triggered: 'search_notes',
        expected_behavior: 'Returns matching notes.',
      },
    ])
    expect(openai.review.commerce).toBe(false)
    expect(buildPluginMcpConfig(CTX).mcpServers).toEqual({
      notes: { type: 'streamable-http', url: 'https://mcp.notes.example/mcp' },
    })
  })

  it('declares commerce only when the listing describes it', () => {
    const review = buildPluginManifest(with_({ commerce: 'Sells note packs.' })).extensions[
      'com.openai'
    ].review
    expect(review).toMatchObject({ commerce: true, commerce_description: 'Sells note packs.' })
  })
})

describe('claudeSubmission', () => {
  it('fills the portal’s fields and sorts tools by what they may change', () => {
    const write: McpTool = {
      ...TOOL,
      name: 'delete_note',
      title: 'Delete note',
      hints: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }
    const sheet = claudeSubmission({ ...CTX, tools: [TOOL, write] })
    expect(sheet).toContain('Server URL: https://mcp.notes.example/mcp')
    expect(sheet).toContain('Read-only (1)\n- `search_notes` — Search notes')
    expect(sheet).toContain('Write (1)\n- `delete_note` — Delete note')
    expect(sheet).toContain('Data access: Both')
    expect(sheet).toContain('Privacy policy URL: https://notes.example/privacy')
  })
})
