// Publishes the MCP worker's entry to the official MCP Registry — `bun run mcp:publish`.
//
// The registry is the upstream feed: the aggregators and client marketplaces
// that people actually browse pull from it, so one publish here reaches them
// without a submission to each. It is the only one of the three directories
// that can be driven from CI; .github/workflows/mcp-publish.yml runs this on
// every push to main that touches the listing.
//
// What it does, in order:
//
//   1. Builds server.json from mcp/listing.json, fleet.json and
//      mcp/package.json (scripts/lib/mcp-listing.ts) and writes it to
//      mcp/.publish/server.json.
//   2. Stops, successfully, when the listing says `publish: false`.
//   3. Asks the registry whether this version exists. The same contents: done,
//      nothing to do. Different contents: fails, because a published version is
//      immutable and the edit would otherwise never reach anyone. Bump
//      mcp/package.json › version.
//   4. Logs in and publishes with `mcp-publisher`, the registry's own CLI.
//
// Step 3 is what makes this safe to run on every push: a deploy that changed no
// listing field publishes nothing.
//
//   bun run mcp:publish             # publish if there is something new
//   bun run mcp:publish --dry-run   # steps 1–3 only; says what would happen
//
// Auth follows listing.json › registry.auth:
//   github-oidc  GitHub Actions mints the token (`id-token: write`); no secret.
//                Locally, run `mcp-publisher login github` first.
//   dns | http   MCP_PRIVATE_KEY holds the hex Ed25519 key whose public half is
//                in the domain's TXT record or /.well-known/mcp-registry-auth.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasMcpWorker, loadMcp, printProblems } from './lib/mcp-context'
import { buildServerJson, listingProblems, namespaceDomain } from './lib/mcp-listing'

const ROOT = resolve(import.meta.dir, '..')
const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io'
const registry = (process.env.MCP_REGISTRY_URL ?? OFFICIAL_REGISTRY).replace(/\/+$/, '')
const dryRun = process.argv.includes('--dry-run')

/** Tells the workflow whether to bother installing the publisher. */
function setOutput(publish: boolean) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
}

function done(message: string): never {
  console.info(`mcp:publish — ${message}`)
  setOutput(false)
  process.exit(0)
}

if (!hasMcpWorker(ROOT)) done('no mcp/ worker in this checkout')

const { ctx, appMcpUrl, problems } = loadMcp(ROOT)
if (ctx) problems.push(...listingProblems(ctx, appMcpUrl))
if (!ctx || problems.length) {
  printProblems('mcp:publish', problems)
  process.exit(1)
}

const serverJson = buildServerJson(ctx)
const outDir = join(ROOT, 'mcp', '.publish')
const serverJsonPath = join(outDir, 'server.json')
mkdirSync(outDir, { recursive: true })
writeFileSync(serverJsonPath, `${JSON.stringify(serverJson, null, 2)}\n`)

const { name, auth } = ctx.listing.registry
const label = `${name}@${ctx.version}`

if (!ctx.listing.publish) {
  done('skipped, mcp/listing.json has publish: false (wrote mcp/.publish/server.json)')
}

// ── Is this version already there? ───────────────────────────────────────────

/** Key order is not part of a JSON document; compare without it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const lookup = `${registry}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(ctx.version)}`
const existing = await fetch(lookup, {
  headers: { accept: 'application/json', 'user-agent': 'mcp-publish' },
  signal: AbortSignal.timeout(30_000),
})

if (existing.ok) {
  const published = ((await existing.json()) as { server?: Record<string, unknown> }).server ?? {}
  // Only the fields this script sets: the registry may add its own beside them.
  const changed = Object.entries(serverJson)
    .filter(([key, value]) => canonical(published[key]) !== canonical(value))
    .map(([key]) => key)
  if (changed.length === 0) done(`${label} is already published and unchanged`)

  console.error(`\nmcp:publish failed — ${label} is already published with different contents\n`)
  console.error(`  changed: ${changed.join(', ')}`)
  console.error('  A published version cannot be edited, so this change would reach nobody.')
  console.error('  → bump "version" in mcp/package.json and push again\n')
  process.exit(1)
}
if (existing.status !== 404) {
  console.error(`\nmcp:publish failed — ${lookup} answered HTTP ${existing.status}\n`)
  process.exit(1)
}

if (dryRun) {
  console.info(`mcp:publish — would publish ${label} to ${registry}`)
  console.info(JSON.stringify(serverJson, null, 2))
  setOutput(true)
  process.exit(0)
}

// ── Log in and publish ───────────────────────────────────────────────────────

const publisher = process.env.MCP_PUBLISHER ?? Bun.which('mcp-publisher')
if (!publisher) {
  console.error('\nmcp:publish failed — `mcp-publisher` is not installed\n')
  console.error('  → brew install mcp-publisher, or set MCP_PUBLISHER to the binary’s path')
  console.error('    (CI installs a pinned, signature-verified release; see mcp-publish.yml)\n')
  process.exit(1)
}

async function run(args: string[]) {
  const proc = Bun.spawn([publisher!, ...args], { stdio: ['inherit', 'inherit', 'inherit'] })
  const code = await proc.exited
  if (code !== 0) {
    console.error(`\nmcp:publish failed — \`mcp-publisher ${args[0]}\` exited ${code}\n`)
    process.exit(code)
  }
}

const registryFlag = registry === OFFICIAL_REGISTRY ? [] : [`--registry=${registry}`]
if (auth === 'github-oidc') {
  // Outside Actions there is no OIDC token to mint; the stored token from an
  // earlier `mcp-publisher login github` is used instead.
  if (process.env.GITHUB_ACTIONS) await run(['login', 'github-oidc', ...registryFlag])
} else if (process.env.MCP_PRIVATE_KEY) {
  // The key is read from the environment by the CLI itself, never passed as an
  // argument, so it does not appear in a process listing or a CI log.
  await run(['login', auth, `--domain=${namespaceDomain(name)}`, ...registryFlag])
} else if (process.env.CI) {
  console.error('\nmcp:publish failed — MCP_PRIVATE_KEY is not set\n')
  console.error(`  registry.auth is "${auth}", which signs in with the domain’s private key.`)
  console.error('  → add it as the MCP_REGISTRY_PRIVATE_KEY repository secret\n')
  process.exit(1)
}

await run(['publish', serverJsonPath])
console.info(`mcp:publish — published ${label}`)
