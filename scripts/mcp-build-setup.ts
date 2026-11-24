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

import {
  desiredBranchTrigger,
  desiredBuild,
  desiredProductionTrigger,
  isCurrent,
  triggerState,
  type BuildConfig,
  type DesiredTrigger,
  type Trigger,
} from './lib/mcp-build'

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

const triggersOf = async (tag: string) => {
  const listed = await api<Trigger[]>('GET', `/builds/workers/${tag}/triggers`)
  return listed.success ? listed.result : []
}
// A worker with no trigger has no build configuration yet: its GET fails.
const configOf = async (tag: string) => {
  const read = await api<BuildConfig>('GET', `/builds/workers/${tag}`)
  return read.success ? read.result : null
}

const want = desiredBuild({ mcpTag, app: app.result })
const appTriggers = await triggersOf(appTag)
const wantProduction = desiredProductionTrigger({ mcpName, mcpTag, build: want, appTriggers })
const wantBranch = desiredBranchTrigger({ mcpTag, build: want, appTriggers })

const have = await configOf(mcpTag)
const triggersBefore = await triggersOf(mcpTag)
const configCurrent = isCurrent(have, want)
const productionBefore = triggerState(triggersBefore, wantProduction)
const branchBefore = triggerState(triggersBefore, wantBranch)

if (configCurrent && productionBefore.current && branchBefore.current) {
  console.info(
    `mcp:build:setup — "${mcpName}" already builds from ${want.production_settings.root_directory}/ on every push; nothing changed`,
  )
  process.exit(0)
}

if (dryRun) {
  const theApps = "(the app's)"
  const shown = (trigger: DesiredTrigger, state: { uuid?: string; current: boolean }) => ({
    action: state.current ? 'none' : state.uuid ? `PATCH ${state.uuid}` : 'POST',
    ...trigger,
    build_token_uuid: theApps,
    repo_connection_uuid: theApps,
  })
  console.info(`mcp:build:setup — would set up "${mcpName}"'s Workers Build:`)
  console.info(
    JSON.stringify(
      {
        production_trigger: shown(wantProduction, productionBefore),
        build_config: configCurrent
          ? 'current'
          : {
              ...want,
              production_settings: { ...want.production_settings, build_token_uuid: theApps },
              previews_base_config: { ...want.previews_base_config, build_token_uuid: theApps },
            },
        branch_trigger: shown(wantBranch, branchBefore),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

// A trigger's Worker and repository are fixed when it is created; a PATCH
// carries only what it may change.
async function saveTrigger(want: DesiredTrigger, state: { current: boolean; uuid?: string }) {
  if (state.current) return
  const { external_script_id: _script, repo_connection_uuid: _repo, ...changes } = want
  const saved = state.uuid
    ? await api<Trigger>('PATCH', `/builds/triggers/${state.uuid}`, changes)
    : await api<Trigger>('POST', '/builds/triggers', want)
  if (!saved.success) fail(`Cloudflare refused the trigger "${want.trigger_name}": ${why(saved)}`)
}

// The production trigger first: it is what creates the build configuration.
await saveTrigger(wantProduction, productionBefore)

// Then the branch settings, written whole. The trigger leaves them unset, and
// the first write of them must be complete.
if (!isCurrent(await configOf(mcpTag), want)) {
  const saved = await api<BuildConfig>('PATCH', `/builds/workers/${mcpTag}`, {
    git_repository: want.git_repository,
    production_settings: want.production_settings,
    previews_enabled: want.previews_enabled,
    previews_base_config: want.previews_base_config,
  })
  if (!saved.success) fail(`Cloudflare refused the settings: ${why(saved)}`)
}

// Looked up again: the production trigger may have been just created.
await saveTrigger(wantBranch, triggerState(await triggersOf(mcpTag), wantBranch))

// Read back rather than trusted: the API accepts fields it then drops.
const storedTriggers = await triggersOf(mcpTag)
if (
  !isCurrent(await configOf(mcpTag), want) ||
  !triggerState(storedTriggers, wantProduction).current ||
  !triggerState(storedTriggers, wantBranch).current
) {
  fail('Cloudflare accepted the settings but did not store them all; compare with --dry-run')
}

console.info(
  `mcp:build:setup — "${mcpName}" now has its own Workers Build (root ${want.production_settings.root_directory}/, ` +
    `deploy \`${want.production_settings.deploy_command}\`). The next push to the production branch deploys it; ` +
    `other branches run \`${wantBranch.build_command}\` and upload nothing.`,
)
