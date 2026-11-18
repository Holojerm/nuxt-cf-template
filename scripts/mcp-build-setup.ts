// `bun run mcp:build:setup` — give the MCP worker a Workers Build of its own.
//
// After this, every push to the production branch deploys the worker: Cloudflare
// builds it from `mcp/`, waits for the app's migrations, and runs its deploy
// (mcp/package.json › deploy:ci). Run it once per fork, after the worker's first
// deploy by hand (`bun run mcp:deploy`), and again whenever it says the
// configuration drifted. `--dry-run` prints what it would send.
//
// It needs a USER API token, in CLOUDFLARE_API_TOKEN, with "Workers Builds
// Configuration: Edit" and "Workers Scripts: Read" (the Builds API refuses
// account-scoped tokens), and CLOUDFLARE_ACCOUNT_ID. The token wrangler logs in
// with does not carry the first permission.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { desiredBuild, isCurrent, type BuildConfig } from './lib/mcp-build'

const ROOT = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run')

function fail(message: string): never {
  console.error(`\nmcp:build:setup — ${message}\n`)
  process.exit(1)
}

const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID
if (!token || !account) {
  fail(
    'set CLOUDFLARE_API_TOKEN (a user token with "Workers Builds Configuration: Edit" and ' +
      '"Workers Scripts: Read") and CLOUDFLARE_ACCOUNT_ID',
  )
}

// The app's name is the first top-level `name` in wrangler.toml; the worker's
// is the first `"name"` in mcp/wrangler.jsonc.
const appName = /^name\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'),
)?.[1]
const mcpName = /^\s*"name":\s*"([^"]+)"/m.exec(
  readFileSync(join(ROOT, 'mcp', 'wrangler.jsonc'), 'utf8'),
)?.[1]
if (!appName || !mcpName)
  fail('could not read a Worker name from wrangler.toml and mcp/wrangler.jsonc')

interface Envelope<T> {
  success: boolean
  result: T
  errors?: { code: number; message: string }[]
}

async function api<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await response.json()) as Envelope<T>
}

const why = (envelope: Envelope<unknown>) =>
  (envelope.errors ?? []).map((error) => `${error.code} ${error.message}`).join('; ') ||
  'no reason given'

const scripts = await api<{ id: string; tag: string }[]>('GET', '/workers/scripts')
if (!scripts.success) fail(`could not list Workers: ${why(scripts)}`)
const tagOf = (name: string) => scripts.result.find((script) => script.id === name)?.tag
const appTag = tagOf(appName)
const mcpTag = tagOf(mcpName)
if (!appTag) fail(`no Worker named "${appName}" on this account`)
if (!mcpTag) fail(`no Worker named "${mcpName}" yet: deploy it once with \`bun run mcp:deploy\``)

const app = await api<BuildConfig>('GET', `/builds/workers/${appTag}`)
if (!app.success) fail(`could not read "${appName}"'s Workers Build: ${why(app)}`)

const want = desiredBuild({ mcpTag, app: app.result })
const existing = await api<BuildConfig>('GET', `/builds/workers/${mcpTag}`)
const have = existing.success ? existing.result : null

if (isCurrent(have, want)) {
  console.info(
    `mcp:build:setup — "${mcpName}" already builds from ${want.production_settings.root_directory}/ on every push`,
  )
  process.exit(0)
}

if (dryRun) {
  console.info(
    `mcp:build:setup — would ${have ? 'update' : 'create'} "${mcpName}"'s Workers Build:`,
  )
  console.info(
    JSON.stringify(
      {
        ...want,
        production_settings: { ...want.production_settings, build_token_uuid: "(the app's)" },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const saved = have
  ? await api<BuildConfig>('PATCH', `/builds/workers/${mcpTag}`, want)
  : await api<BuildConfig>('POST', '/builds/workers', want)
if (!saved.success) fail(`Cloudflare refused the configuration: ${why(saved)}`)

console.info(
  `mcp:build:setup — "${mcpName}" now has its own Workers Build (root ${want.production_settings.root_directory}/, ` +
    `deploy \`${want.production_settings.deploy_command}\`). The next push to the production branch deploys it.`,
)
