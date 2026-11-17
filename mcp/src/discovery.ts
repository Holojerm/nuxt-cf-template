// Public discovery routes: what a directory, a registry crawler or an MCP client
// may read about this server before it holds a token.
//
//   GET /mcp/server-card                    the Server Card (SEP-2127)
//   GET /.well-known/ai-catalog.json        an AI Catalog pointing at that card
//   GET /.well-known/openai-apps-challenge  ChatGPT's domain-verification token
//
// These run BEFORE the OAuth provider (see index.ts). `/mcp/server-card` is the
// location the Server Card extension reserves, `<streamable-http-url>/server-card`,
// and it sits under the provider's `apiRoute`, which is a prefix match: left to
// the provider, a card request gets a 401 asking for a bearer token.
//
// The card says where to connect, nothing else. It lists no tools on purpose:
// the extension leaves primitives to the live `tools/list`, because a static
// copy can drift from what an authenticated caller is actually offered.
//
// The card and the catalog 404 until `listing.json` names a real registry
// namespace. A fork that has not chosen one would otherwise advertise the
// template's `YOUR_GITHUB_OWNER` placeholder to every crawler that asks.

import fleet from '../../fleet.json'
import listing from '../listing.json'
import pkg from '../package.json'

/** The Streamable HTTP endpoint. index.ts hands the same string to the OAuth provider. */
export const MCP_PATH = '/mcp'

const CARD_PATH = `${MCP_PATH}/server-card`
const CATALOG_PATH = '/.well-known/ai-catalog.json'
const CHALLENGE_PATH = '/.well-known/openai-apps-challenge'

const CARD_TYPE = 'application/mcp-server-card+json'
const CATALOG_TYPE = 'application/ai-catalog+json'

/** What the two documents are built from. A parameter so tests can supply one. */
export interface DiscoverySource {
  /** `<namespace>/<server>`, the name the registry lists this server under. */
  registryName: string
  summary: string
  version: string
  title: string
  /** The app's production origin, no trailing slash. */
  website: string
}

/** This worker's own: listing.json, mcp/package.json's version, fleet.json. */
const SOURCE: DiscoverySource = {
  registryName: listing.registry.name,
  summary: listing.summary,
  version: pkg.version,
  title: fleet.name,
  website: fleet.urls.prod.replace(/\/+$/, ''),
}

/** False while the name still carries the template's placeholder namespace. */
const isListed = (source: DiscoverySource) => !source.registryName.includes('YOUR_')

// The extension requires these on a hosted card so a browser-based client can
// read it. Safe on both documents: they are public and read-only.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
}

/**
 * The Server Card for the server answering at `origin`.
 *
 * `remotes` is built from the request's own origin rather than `listing.url`,
 * so a preview deploy or a workers.dev hostname describes itself and never
 * sends a client to production. The identity fields are the ones
 * scripts/lib/mcp-listing.ts publishes to the registry as server.json;
 * test/mcp-listing.test.ts holds the two together.
 */
export function serverCard(source: DiscoverySource, origin: string) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: source.registryName,
    version: source.version,
    description: source.summary,
    title: source.title,
    websiteUrl: source.website,
    icons: [{ src: `${source.website}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }],
    remotes: [{ type: 'streamable-http', url: `${origin}${MCP_PATH}` }],
  }
}

/** One entry, linking to the card instead of repeating its fields. */
export function aiCatalog(source: DiscoverySource, origin: string) {
  const serverName = source.registryName.split('/').pop() ?? ''
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: `urn:air:${new URL(origin).hostname}:mcp:${serverName}`,
        type: CARD_TYPE,
        url: `${origin}${CARD_PATH}`,
      },
    ],
  }
}

async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `"${hex}"`
}

const notFound = () => new Response('Not found\n', { status: 404 })

async function publicJson(request: Request, document: unknown, type: string): Promise<Response> {
  const body = `${JSON.stringify(document, null, 2)}\n`
  const etag = await etagFor(body)
  const headers = {
    ...CORS,
    'Content-Type': type,
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
  }
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers })
}

/** The response for a discovery route, or null when the request is not for one. */
export async function discoveryResponse(
  request: Request,
  env: { OPENAI_APPS_CHALLENGE?: string },
  source: DiscoverySource = SOURCE,
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (path !== CARD_PATH && path !== CATALOG_PATH && path !== CHALLENGE_PATH) return null

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  if (path === CHALLENGE_PATH) {
    // ChatGPT's submission portal issues the token and fetches it from here. The
    // body must be the token alone: no JSON, no trailing newline. Unset is a 404,
    // so a server that never applied advertises nothing.
    const token = env.OPENAI_APPS_CHALLENGE?.trim()
    if (!token) return notFound()
    return new Response(request.method === 'HEAD' ? null : token, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  if (!isListed(source)) return notFound()
  return path === CARD_PATH
    ? publicJson(request, serverCard(source, url.origin), CARD_TYPE)
    : publicJson(request, aiCatalog(source, url.origin), CATALOG_TYPE)
}
