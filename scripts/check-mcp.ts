// MCP listing gate — run with `bun run mcp:check`, wired into `bun run ci`.
//
// The MCP worker is listed in three directories (the official MCP Registry,
// Claude's, ChatGPT's), and every way of getting that wrong is silent here. A
// tool without annotations builds, deploys and answers calls; the first sign is
// a portal flagging it at review. A test prompt that names a tool renamed last
// month still parses. An app that links to one MCP URL while the registry
// lists another serves both without complaint. So the listing is checked
// against the things it describes on every CI run, the way check-fleet.ts
// checks fleet.json.
//
// Rules:
//
//   1. Every `registerTool()` call in mcp/src is readable from source, and
//      declares a `title`, a `description` and all three annotation hints
//      (readOnlyHint, destructiveHint, openWorldHint) as literals.
//   2. No tool name is registered twice.
//   3. mcp/package.json has a `version`.
//   4. mcp/listing.json matches McpListingSchema (scripts/lib/mcp-listing.ts),
//      including the directories' length limits.
//   5. Every tool a test case names exists.
//   6. NUXT_PUBLIC_MCP_URL in wrangler.toml, when set, is the listing's `url`,
//      and the listing has a real registry name by then.
//   7. With `publish: true`, the registry entry is publishable: no placeholder
//      name or host, an auth method that fits the namespace, a semver version,
//      and the app advertising the same server.
//
// What a directory needs beyond that (a docs page, five test cases, a demo
// recording) is not a rule here. `bun run mcp:pack` prints it as a checklist,
// because a fork may list in one directory and not another.
//
// A fork that removed mcp/ (TEARDOWN.md) has nothing to check, and this passes.

import { resolve } from 'node:path'

import { hasMcpWorker, loadMcp, printProblems } from './lib/mcp-context'
import { listingProblems } from './lib/mcp-listing'

const ROOT = resolve(import.meta.dir, '..')

if (!hasMcpWorker(ROOT)) {
  console.info('mcp:check — no mcp/ worker in this checkout, nothing to check')
  process.exit(0)
}

const { ctx, appMcpUrl, problems } = loadMcp(ROOT)
if (ctx) problems.push(...listingProblems(ctx, appMcpUrl))

if (problems.length === 0 && ctx) {
  const state = ctx.listing.publish
    ? `published as ${ctx.listing.registry.name}@${ctx.version}`
    : 'publish is off'
  console.info(`mcp:check — ${ctx.tools.length} tool(s) annotated, listing valid, ${state}`)
  process.exit(0)
}

printProblems('mcp:check', problems)
console.error(
  'mcp/listing.json is what the MCP directories are told; .claude/docs/mcp.md explains each field.\n',
)
process.exit(1)
