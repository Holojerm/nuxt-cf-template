// The MCP worker's directory listing: the shape of mcp/listing.json, and
// everything derived from it. Pure functions, no filesystem — scripts/check-mcp.ts,
// scripts/mcp-publish.ts and scripts/mcp-pack.ts read the files and call in here,
// and test/mcp-listing.test.ts drives the rules directly.
//
// ── One source, three destinations ──────────────────────────────────────────
// An MCP server is listed in three places that each want the same facts in a
// different envelope:
//
//   the official MCP Registry   a `server.json`, published by `mcp-publisher`
//   Claude's Connectors Directory   a ten-step portal form, typed in by hand
//   ChatGPT's directory         a plugin ZIP (`plugin.json` + `mcp.json` + icons)
//
// Three hand-kept copies drift, and a drifted listing does not fail: the
// directory just goes on describing last quarter's server. So mcp/listing.json
// holds only what exists nowhere else in the repo (the copy, the registry
// namespace, the test prompts), and the rest is read from where it already
// lives: the app's name and URL from fleet.json, the version from
// mcp/package.json, the publisher from wrangler.toml [vars], the tools from the
// worker's own source.

import { z } from 'zod'

import type { McpTool } from './mcp-tools'

/** The registry's server.json schema this builds against. */
export const SERVER_JSON_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'

/** The path the worker serves Streamable HTTP on (`MCP_PATH` in mcp/src/discovery.ts). */
export const MCP_PATH = '/mcp'

/** The registry's own pattern for a server name. */
const REGISTRY_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/

/**
 * True while a value still carries a `YOUR_…` template placeholder. The schema
 * lets one through (the template has to parse); every rule that matters for a
 * server someone can reach refuses it.
 */
export const isPlaceholder = (value: string) => value.includes('YOUR_')

const httpsUrl = z.url().regex(/^https:\/\//, 'an https:// URL')
/** Empty means "not written yet"; readiness() reports it, the schema does not. */
const optionalUrl = z.union([z.literal(''), httpsUrl])
const line = z.string().min(1)

export const McpListingSchema = z.strictObject({
  /**
   * True once this server is meant to be found: CI publishes it to the official
   * MCP Registry on every push to main. False keeps a fork that never deployed
   * the worker out of every directory.
   */
  publish: z.boolean(),

  /** The worker's public origin, no path and no trailing slash. */
  url: z.string().regex(/^https:\/\/[^/\s]+$/, 'an https:// origin with no path'),

  registry: z.strictObject({
    /**
     * `<namespace>/<server>`. The namespace is what the registry verifies:
     * `io.github.<owner>` for GitHub auth, or a reversed domain you control
     * (`com.example`) for DNS or HTTP auth.
     */
    name: z
      .string()
      .min(3)
      .max(200)
      .refine((name) => isPlaceholder(name) || REGISTRY_NAME.test(name), {
        error: '<namespace>/<server>, e.g. com.example/notes',
      }),
    /** How CI proves it owns the namespace. See .claude/docs/mcp.md › Registry. */
    auth: z.enum(['github-oidc', 'dns', 'http']),
  }),

  /** Display name. Defaults to fleet.json › name. */
  title: z.string().min(1).max(100).optional(),
  /** ChatGPT's subtitle, and the shortest thing a directory shows. */
  tagline: z.string().min(1).max(30),
  /** One sentence. The registry's `description` and Claude's one-liner. */
  summary: z.string().min(1).max(100),
  /** The long description. 2,000 is Claude's limit, the lower of the two. */
  description: z.string().min(1).max(2000),
  categories: z.array(line).min(1).max(5),
  keywords: z.array(line).default([]),
  /** What people use it for, one per line. Claude asks; ChatGPT lists them. */
  useCases: z.array(line).default([]),
  /** What someone needs before they can connect: an account, a plan, a code. */
  prerequisites: z.string().default(''),
  /** Why and how the server takes payments. Empty means it takes none. */
  commerce: z.string().default(''),

  links: z.strictObject({
    /** Setup and usage instructions. Both directories require one. */
    docs: optionalUrl,
    /** A support page. ChatGPT requires an https URL, not an address. */
    support: optionalUrl,
    /** Default: fleet.json › urls.prod. */
    website: optionalUrl.optional(),
    /** Default: `/privacy` on the website. */
    privacy: optionalUrl.optional(),
    /** Default: `/terms` on the website. */
    terms: optionalUrl.optional(),
  }),

  /** Prompts a directory can offer as starting points. */
  prompts: z.array(line).default([]),

  /** What a reviewer runs. ChatGPT requires five positive and three negative. */
  testCases: z
    .strictObject({
      positive: z
        .array(
          z.strictObject({
            description: line,
            prompt: line,
            /** Tool names the prompt should trigger; check-mcp verifies they exist. */
            tools: z.array(line).min(1),
            expected: line,
          }),
        )
        .default([]),
      negative: z.array(z.strictObject({ description: line, prompt: line })).default([]),
    })
    .default({ positive: [], negative: [] }),

  /** A screen recording of the server in use. ChatGPT's review requires one. */
  demoRecordingUrl: optionalUrl.default(''),
  /** What changed in this version, for ChatGPT's listing. */
  releaseNotes: z.string().default(''),
})

export type McpListing = z.infer<typeof McpListingSchema>

/** Everything the builders need, gathered by the script that calls them. */
export interface ListingContext {
  listing: McpListing
  /** mcp/package.json › version. */
  version: string
  /** fleet.json: slug, name, urls.prod. */
  app: { slug: string; name: string; url: string }
  /** wrangler.toml [vars]: NUXT_PUBLIC_LEGAL_ENTITY and NUXT_PUBLIC_SUPPORT_EMAIL. */
  publisher: { name: string; email: string }
  tools: McpTool[]
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/** Hosts the template ships with. Nothing answers on them. */
const PLACEHOLDER_HOST = /(^|\.)example\.(workers\.dev|com|org|net)$/

/** True for a URL still pointing at a template placeholder host, or not a URL. */
export function isPlaceholderUrl(url: string): boolean {
  try {
    return PLACEHOLDER_HOST.test(new URL(url).hostname)
  } catch {
    return true
  }
}

/** The listing's links with the defaults filled in from the app's own URL. */
export function resolveLinks(ctx: ListingContext) {
  const { links } = ctx.listing
  const website = trimSlash(links.website || ctx.app.url)
  return {
    website,
    docs: links.docs,
    support: links.support,
    privacy: links.privacy || `${website}/privacy`,
    terms: links.terms || `${website}/terms`,
    icon: `${trimSlash(ctx.app.url)}/icon-512.png`,
  }
}

export const listingTitle = (ctx: ListingContext) => ctx.listing.title ?? ctx.app.name

/** The Streamable HTTP endpoint clients connect to. */
export const mcpEndpoint = (listing: McpListing) => `${trimSlash(listing.url)}${MCP_PATH}`

/**
 * The domain a DNS- or HTTP-verified namespace stands for: `com.example` is
 * `example.com`. This is what `mcp-publisher login dns --domain` is given.
 */
export function namespaceDomain(registryName: string): string {
  return (registryName.split('/')[0] ?? '').split('.').reverse().join('.').toLowerCase()
}

/**
 * The document published to the official MCP Registry.
 *
 * Remote-only: no `packages`, because nothing is installed; a client connects
 * to the URL. The identity fields are the same ones the worker serves in its
 * Server Card (mcp/src/discovery.ts), so a client that finds the server either
 * way reads one description of it.
 */
export function buildServerJson(ctx: ListingContext) {
  const links = resolveLinks(ctx)
  return {
    $schema: SERVER_JSON_SCHEMA,
    name: ctx.listing.registry.name,
    title: listingTitle(ctx),
    description: ctx.listing.summary,
    version: ctx.version,
    websiteUrl: links.website,
    icons: [{ src: links.icon, mimeType: 'image/png', sizes: ['512x512'] }],
    remotes: [{ type: 'streamable-http', url: mcpEndpoint(ctx.listing) }],
  }
}

/** `plugin.json` for ChatGPT's directory, in the Agent Plugins format. */
export function buildPluginManifest(ctx: ListingContext) {
  const { listing } = ctx
  const links = resolveLinks(ctx)
  return {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: ctx.app.slug,
    version: ctx.version,
    description: listing.summary,
    author: { name: ctx.publisher.name, email: ctx.publisher.email, url: links.website },
    homepage: links.website,
    keywords: listing.keywords,
    extensions: {
      'com.openai': {
        interface: {
          displayName: listingTitle(ctx),
          shortDescription: listing.tagline,
          longDescription: listing.description,
          developerName: ctx.publisher.name,
          category: listing.categories[0],
          capabilities: listing.useCases.length
            ? listing.useCases
            : ctx.tools.map((tool) => tool.title ?? tool.name),
          websiteURL: links.website,
          supportURL: links.support,
          privacyPolicyURL: links.privacy,
          termsOfServiceURL: links.terms,
          defaultPrompt: listing.prompts,
          composerIcon: './assets/icon.png',
          logo: './assets/logo.png',
        },
        review: {
          test_cases: {
            positive: listing.testCases.positive.map((test) => ({
              description: test.description,
              prompt: test.prompt,
              tools_triggered: test.tools.join(', '),
              expected_behavior: test.expected,
            })),
            negative: listing.testCases.negative,
          },
          ...(listing.demoRecordingUrl ? { demo_recording_url: listing.demoRecordingUrl } : {}),
          commerce: listing.commerce !== '',
          ...(listing.commerce ? { commerce_description: listing.commerce } : {}),
        },
        ...(listing.releaseNotes ? { publication: { release_notes: listing.releaseNotes } } : {}),
      },
    },
  }
}

/** `mcp.json` beside it: the one remote server the plugin connects to. */
export function buildPluginMcpConfig(ctx: ListingContext) {
  return {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { [ctx.app.slug]: { type: 'streamable-http', url: mcpEndpoint(ctx.listing) } },
  }
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface Check {
  ok: boolean
  label: string
  /** What to change, when `ok` is false. */
  fix?: string
}

const check = (ok: boolean, label: string, fix: string): Check =>
  ok ? { ok, label } : { ok, label, fix }

/** Version ranges are refused by the registry; this keeps to plain semver. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export const CHATGPT_POSITIVE_CASES = 5
export const CHATGPT_NEGATIVE_CASES = 3

/**
 * What each destination still needs, as a checklist.
 *
 * The registry list is the one CI enforces: `publish: true` with any of it
 * failing fails `bun run mcp:check`. The other two are advice printed by
 * `bun run mcp:pack`, because a fork may list in one directory and not the
 * other, and neither can be submitted from CI anyway.
 */
export function readiness(ctx: ListingContext) {
  const { listing } = ctx
  const links = resolveLinks(ctx)
  const title = listingTitle(ctx)
  const githubNamespace = listing.registry.name.startsWith('io.github.')

  const realUrl = check(
    !isPlaceholderUrl(listing.url),
    'url is the deployed worker',
    'set mcp/listing.json › url to the origin the MCP worker serves',
  )
  const realWebsite = check(
    !isPlaceholderUrl(links.website),
    'the website is a real origin',
    'set fleet.json › urls.prod (and NUXT_PUBLIC_APP_URL) to the production origin',
  )
  const hasTools = check(
    ctx.tools.length > 0,
    'the server registers at least one tool',
    'register a tool in mcp/src/server.ts',
  )
  const hasDocs = check(
    listing.links.docs !== '',
    'a documentation URL',
    'write a public page on connecting and using the server, and set links.docs',
  )
  const realPublisher = check(
    ctx.publisher.name !== '' && !/@example\.com$/.test(ctx.publisher.email),
    'a publisher name and support address',
    'set NUXT_PUBLIC_LEGAL_ENTITY and NUXT_PUBLIC_SUPPORT_EMAIL in wrangler.toml [vars]',
  )
  /** What any directory needs before a person can be sent to the server. */
  const reachable = [realUrl, realWebsite, hasTools, hasDocs, realPublisher]

  const registry: Check[] = [
    check(
      !isPlaceholder(listing.registry.name),
      'registry.name names a real namespace',
      'replace YOUR_GITHUB_OWNER in mcp/listing.json › registry.name, or use a reversed domain you control',
    ),
    check(
      (listing.registry.auth === 'github-oidc') === githubNamespace,
      'registry.auth matches the namespace',
      'an `io.github.<owner>` namespace takes "github-oidc"; a reversed domain takes "dns" or "http"',
    ),
    realUrl,
    realWebsite,
    check(
      SEMVER.test(ctx.version),
      'the version is plain semver',
      'set mcp/package.json › version to x.y.z; the registry refuses ranges',
    ),
  ]

  const claude: Check[] = [
    ...reachable,
    check(
      listing.useCases.length > 0,
      'at least one use case',
      'add to mcp/listing.json › useCases',
    ),
    check(
      listing.prerequisites !== '',
      'what a user needs before connecting',
      'fill in mcp/listing.json › prerequisites',
    ),
  ]

  const chatgpt: Check[] = [
    ...reachable,
    check(
      title.length <= 30,
      'a display name of 30 characters or fewer',
      `"${title}" is ${title.length}; set a shorter mcp/listing.json › title`,
    ),
    check(
      listing.links.support !== '',
      'a support URL',
      'ChatGPT wants an https page, not an address: set links.support',
    ),
    check(
      listing.testCases.positive.length >= CHATGPT_POSITIVE_CASES,
      `${CHATGPT_POSITIVE_CASES} positive test cases`,
      `testCases.positive has ${listing.testCases.positive.length}`,
    ),
    check(
      listing.testCases.negative.length >= CHATGPT_NEGATIVE_CASES,
      `${CHATGPT_NEGATIVE_CASES} negative test cases`,
      `testCases.negative has ${listing.testCases.negative.length}`,
    ),
    check(
      listing.demoRecordingUrl !== '',
      'a demo recording',
      'record the server in use and set demoRecordingUrl',
    ),
    check(listing.releaseNotes !== '', 'release notes', 'set releaseNotes for this version'),
  ]

  return { registry, claude, chatgpt }
}

// ── Gate rules ───────────────────────────────────────────────────────────────

export interface ListingProblem {
  rule: string
  detail: string
  remedy: string
}

/**
 * What `bun run mcp:check` fails on, beyond the schema.
 *
 * `appMcpUrl` is wrangler.toml's NUXT_PUBLIC_MCP_URL: the app's own claim about
 * where the server is, which drives the account page and the app's
 * `/.well-known/ai-catalog.json`. It and the listing describe one server, so
 * they must agree, and neither may point a crawler at a card that 404s.
 */
export function listingProblems(ctx: ListingContext, appMcpUrl: string): ListingProblem[] {
  const { listing } = ctx
  const problems: ListingProblem[] = []
  const known = new Set(ctx.tools.map((tool) => tool.name))

  for (const test of listing.testCases.positive) {
    const unknown = test.tools.filter((name) => !known.has(name))
    if (unknown.length) {
      problems.push({
        rule: 'test case names a tool that does not exist',
        detail: `"${test.description}" expects ${unknown.join(', ')}`,
        remedy:
          'a renamed or removed tool leaves the reviewer a prompt that cannot pass; fix testCases.positive',
      })
    }
  }

  const advertised = trimSlash(appMcpUrl)
  if (advertised && advertised !== trimSlash(listing.url)) {
    problems.push({
      rule: 'NUXT_PUBLIC_MCP_URL differs from the listing',
      detail: `wrangler.toml [vars] "${advertised}" vs mcp/listing.json url "${listing.url}"`,
      remedy: 'they are one server; the app links to the first and the registry to the second',
    })
  }
  if (advertised && isPlaceholder(listing.registry.name)) {
    problems.push({
      rule: 'the app advertises a server with no registry name',
      detail: `NUXT_PUBLIC_MCP_URL is set, but registry.name is still "${listing.registry.name}"`,
      remedy:
        'the worker 404s its Server Card until registry.name is real, so the app’s AI Catalog would point at nothing',
    })
  }

  if (listing.publish) {
    for (const item of readiness(ctx).registry) {
      if (!item.ok) {
        problems.push({
          rule: `publish is true, but: ${item.label}`,
          detail: 'CI would publish this entry to the official MCP Registry',
          remedy: item.fix ?? '',
        })
      }
    }
    if (!advertised) {
      problems.push({
        rule: 'publish is true, but the app does not advertise the server',
        detail: 'NUXT_PUBLIC_MCP_URL is empty in wrangler.toml [vars]',
        remedy: `set it to "${listing.url}" so the account page and /.well-known/ai-catalog.json point at it`,
      })
    }
  }

  return problems
}

// ── The Claude submission, as a sheet to paste from ──────────────────────────

/** The fields of Claude's ten-step portal form, in its order, filled in. */
export function claudeSubmission(ctx: ListingContext): string {
  const { listing } = ctx
  const links = resolveLinks(ctx)
  const reads = ctx.tools.filter((tool) => tool.hints.readOnlyHint === true)
  const writes = ctx.tools.filter((tool) => tool.hints.readOnlyHint !== true)
  const toolLine = (tool: McpTool) => `- \`${tool.name}\` — ${tool.title ?? ''}`
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : ['- (none)'])
  const access = writes.length === 0 ? 'Reads data' : reads.length === 0 ? 'Writes data' : 'Both'

  return [
    `# Claude Connectors Directory — ${listingTitle(ctx)}`,
    '',
    'Submit at https://claude.ai/directory/manage → Submit new → MCP connector.',
    'Each heading below is one step of the portal, in order.',
    '',
    '## 1. Connection',
    '',
    `Server URL: ${mcpEndpoint(listing)}`,
    '',
    '## 2. Tools',
    '',
    'Synced from the live server. Expect:',
    '',
    `Read-only (${reads.length})`,
    ...(reads.length ? reads.map(toolLine) : ['- (none)']),
    '',
    `Write (${writes.length})`,
    ...(writes.length ? writes.map(toolLine) : ['- (none)']),
    '',
    '## 3. Listing',
    '',
    `Server name: ${listingTitle(ctx)}`,
    `One-liner: ${listing.summary}`,
    `Categories: ${listing.categories.join(', ')}`,
    `Documentation URL: ${links.docs || '(missing)'}`,
    `Privacy policy URL: ${links.privacy}`,
    `Support contact: ${links.support || ctx.publisher.email}`,
    `Icon: public/icon-512.png (${links.icon})`,
    `URL slug: ${ctx.app.slug}  (permanent once published)`,
    '',
    'Description:',
    '',
    listing.description,
    '',
    '## 4. Use cases',
    '',
    ...list(listing.useCases),
    '',
    `Before connecting: ${listing.prerequisites || '(missing)'}`,
    `Data access: ${access}`,
    '',
    '## 5. Company',
    '',
    `Company: ${ctx.publisher.name}`,
    `Website: ${links.website}`,
    `Primary contact: ${ctx.publisher.email}`,
    '',
    '## 6. Authentication',
    '',
    'Sign-in required: yes, OAuth 2.0. The server supports dynamic client',
    'registration, so leave the client ID and secret empty.',
    '',
    '## 7. Data handling',
    '',
    'The underlying API is your own.',
    '',
    '## 8. Test & launch',
    '',
    'Add the server as a custom connector in Claude and call every tool first.',
    'Prompts to run:',
    '',
    ...list(listing.testCases.positive.map((test) => `${test.prompt} → ${test.expected}`)),
    '',
    '## 9. Compliance',
    '',
    'Seven acknowledgments. Read each one; nothing here can answer them for you.',
    '',
  ].join('\n')
}
