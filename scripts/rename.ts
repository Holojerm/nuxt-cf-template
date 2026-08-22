// Project rename — run with `bun run rename <new-name> [--display "New Name"]`.
//
// `my-app` names a lot of things, and none of them can be looked up from the
// others at runtime. In wrangler.toml alone it is the Worker, the D1 database,
// the R2 bucket, the email queue and its dead-letter queue, the display name in
// [vars] — and then all of that again inside [env.preview], because bindings
// are non-inheritable and the preview environment repeats every one of them.
// Outside it: two package.json scripts (wrangler's `d1 migrations` subcommand
// takes a database NAME, not a binding), portless.name, the Nuxt MCP URL, the
// MCP worker's own config, the server name it reports to MCP clients, and the
// fleet manifest (fleet.json) that the portfolio dashboard reads.
//
// Missing one produces failures that don't look like a rename problem at all.
// Workers Builds refuses every build when the dashboard Worker name doesn't
// match wrangler.toml; the Nuxt MCP server just never connects when its URL
// doesn't match portless.name; a queue name that doesn't match the one you
// created makes `wrangler deploy` fail on a resource you're sure exists.
//
// So this replaces every occurrence in every file below, prints the per-file
// count, and refuses to run twice (there's nothing left to match the second
// time). The count is computed, not asserted — adding a `my-app` to a file
// already listed here needs no change to this script.
//
// It deliberately does NOT touch prose: README.md and CLAUDE.md explain the
// template using `my-app` as the worked example, and rewriting them mid-sentence
// makes the docs read like nonsense. The same exemption covers the one
// `my-app-email-preview` left in a comment in server/utils/email-queue.ts,
// which is an example inside an explanation rather than a value anything reads.
// That file used to be a target, back when it held the queue name as a
// constant; the name now lives in wrangler.toml's [vars] precisely because a
// constant could not differ between production and preview.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

const PLACEHOLDER = 'my-app'
const PLACEHOLDER_DISPLAY = 'My App'

// Worker names, D1 names, and hostnames all share this constraint.
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$/

const args = process.argv.slice(2)
const name = args.find((arg) => !arg.startsWith('--'))
const displayFlag = args.indexOf('--display')
const display = displayFlag !== -1 ? args[displayFlag + 1] : undefined

if (!name) {
  console.error('Usage: bun run rename <new-name> [--display "New Name"]')
  console.error(
    '  <new-name>  lowercase, digits and hyphens — used for the Worker, D1, R2, and dev host',
  )
  console.error(
    '  --display   human-readable name shown in the UI (defaults to a title-cased <new-name>)',
  )
  process.exit(1)
}

if (!VALID_NAME.test(name)) {
  console.error(`"${name}" isn't a valid Cloudflare resource name.`)
  console.error('Use lowercase letters, digits, and hyphens; start and end with alphanumeric.')
  process.exit(1)
}

if (name === PLACEHOLDER) {
  console.error(`"${PLACEHOLDER}" is the placeholder this script replaces. Pick another name.`)
  process.exit(1)
}

const displayName =
  display ??
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

interface Target {
  file: string
  /** Optional — the MCP worker isn't installed in every fork. */
  optional?: boolean
}

const TARGETS: Target[] = [
  { file: 'wrangler.toml' },
  { file: 'package.json' },
  { file: '.mcp.json' },
  // The fleet manifest names the Worker (slug, workers[0]) and the D1 / R2
  // resources. `bun run fleet:check` fails the build if it stops matching
  // wrangler.toml, so it has to be renamed in the same pass.
  { file: 'fleet.json' },
  { file: 'mcp/wrangler.jsonc', optional: true },
  { file: 'mcp/package.json', optional: true },
  // The only .ts source in this list, and the only functional placeholder that
  // is not in a config file: `new McpServer({ name: 'my-app-mcp' })`. That name
  // is what an MCP client displays for the connection, so leaving it behind
  // means every user of a renamed fork sees "my-app-mcp" in their client.
  { file: 'mcp/src/server.ts', optional: true },
]

const changes: { file: string; count: number }[] = []
const missing: string[] = []

for (const target of TARGETS) {
  const path = resolve(ROOT, target.file)
  if (!existsSync(path)) {
    if (!target.optional) missing.push(target.file)
    continue
  }

  const before = readFileSync(path, 'utf8')
  // Display name first: "My App" contains no hyphens, so replacing the slug
  // first would leave it untouched anyway — but doing display first keeps the
  // count honest when a fork has already customised one and not the other.
  const after = before.split(PLACEHOLDER_DISPLAY).join(displayName).split(PLACEHOLDER).join(name)

  if (after === before) continue

  const count =
    before.split(PLACEHOLDER).length - 1 + (before.split(PLACEHOLDER_DISPLAY).length - 1)
  writeFileSync(path, after)
  changes.push({ file: target.file, count })
}

if (missing.length) {
  console.error(`Missing expected files: ${missing.join(', ')}`)
  console.error('Are you running this from the project root?')
  process.exit(1)
}

if (!changes.length) {
  console.info(`Nothing to rename — no "${PLACEHOLDER}" placeholders left.`)
  console.info('This project has already been renamed.')
  process.exit(0)
}

console.info(`Renamed ${PLACEHOLDER} → ${name} ("${PLACEHOLDER_DISPLAY}" → "${displayName}")\n`)
for (const change of changes) {
  console.info(`  ${change.file}  (${change.count} replacement${change.count === 1 ? '' : 's'})`)
}

console.info(`
Still yours to do — these need values only you have:

  1. wrangler.toml    paste the real D1 database_id and KV namespace id — for
                      BOTH the top-level block and [env.preview]
  2. wrangler.toml    set NUXT_PUBLIC_APP_URL to your deployed origin
  3. Cloudflare       create the D1 database, KV namespace, R2 bucket and queue:
                        wrangler d1 create ${name}-db
                        wrangler kv namespace create KV
                        wrangler r2 bucket create ${name}-blob
                        wrangler queues create ${name}-email
                      The queue must exist before the first deploy; the
                      dead-letter queue is created for you. See README ›
                      Preview environment for the -preview set.
  4. Workers Builds   the Worker in the dashboard must be named exactly "${name}",
                      or every build fails before it starts
  5. bun install      regenerate the lockfile entry for the renamed package
  6. bun run brand:generate
                      rebuilds favicon.svg, apple-touch-icon.png and og.png with
                      the new name — until you do, every link preview of your
                      site still reads "${PLACEHOLDER_DISPLAY}". \`bun run brand:check\`
                      fails the build until it is run, on purpose.
`)
