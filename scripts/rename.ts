// Project rename — run with `bun run rename <new-name> [--display "New Name"]`.
//
// `my-app` appears in six places across four files, and wrangler's migrations
// subcommand takes a database NAME rather than a binding, so two of them are
// inside package.json scripts. Missing one produces failures that don't look
// like a rename problem at all: Workers Builds refuses every build when the
// dashboard Worker name doesn't match wrangler.toml, and the Nuxt MCP server
// silently fails to connect when its URL doesn't match portless.name.
//
// This script does all six, tells you exactly what it changed, and refuses to
// run twice (there's nothing left to match the second time).
//
// It deliberately does NOT touch README.md or CLAUDE.md — those explain the
// template using `my-app` as the worked example, and rewriting them mid-sentence
// makes the docs read like nonsense.

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
  { file: 'mcp/wrangler.jsonc', optional: true },
  { file: 'mcp/package.json', optional: true },
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

  1. wrangler.toml    paste the real D1 database_id and KV namespace id
  2. wrangler.toml    set NUXT_PUBLIC_APP_URL to your deployed origin
  3. Cloudflare       create the D1 database, KV namespace, and R2 bucket named
                      ${name}-db / ${name}-blob
  4. Workers Builds   the Worker in the dashboard must be named exactly "${name}",
                      or every build fails before it starts
  5. bun install      regenerate the lockfile entry for the renamed package
  6. bun run brand:generate
                      rebuilds favicon.svg, apple-touch-icon.png and og.png with
                      the new name — until you do, every link preview of your
                      site still reads "${PLACEHOLDER_DISPLAY}". \`bun run brand:check\`
                      fails the build until it is run, on purpose.
`)
