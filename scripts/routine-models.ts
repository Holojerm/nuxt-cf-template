// Is `.claude/routines/models.json` still naming the newest model in each tier?
//
//   bun run routines:models            # print the table beside the newest IDs
//   bun run routines:models --check    # exit 1 when a tier is behind (the weekly workflow)
//   bun run routines:models --write    # move each behind tier to the newest ID
//
// The newest IDs come from frontier-terminal's public price catalog (the
// table's `source`), which lists every Anthropic model from Anthropic's own
// pricing page and marks the ones since removed. No API key is needed. A
// removed row is never picked, so this cannot move a tier onto a retired model.
//
// After a write: open the PR, and once it merges, forks take it on their next
// template-sync and `/routines sync` in each repo writes the new ID into the
// live routines. Nothing else updates a live routine's model.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  behind,
  type ModelTable,
  newestByTier,
  type PriceRow,
  tableProblems,
  TIERS,
} from './lib/routine-models'

const PATH = join(resolve(import.meta.dir, '..'), '.claude/routines/models.json')
const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : 'show'

const table = JSON.parse(readFileSync(PATH, 'utf8')) as ModelTable
const invalid = tableProblems(table)
if (invalid.length) {
  console.error(`models.json is invalid: ${invalid.join('; ')} (bun run routines:check)`)
  process.exit(1)
}

const response = await fetch(table.source, {
  headers: { accept: 'application/json', 'user-agent': 'nuxt-cf-template routines:models' },
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) {
  console.error(`${table.source} answered ${response.status}; nothing was compared`)
  process.exit(2)
}
const body = (await response.json()) as { rows?: PriceRow[] }
if (!Array.isArray(body.rows)) {
  console.error(`${table.source} returned no \`rows\` array; nothing was compared`)
  process.exit(2)
}

const newest = newestByTier(body.rows)
// An empty tier means the source stopped listing it, which is a source problem,
// not a reason to keep or drop a model: say so and fail the check.
const missing = TIERS.filter((tier) => !newest[tier])
const stale = behind(table, newest)

for (const tier of TIERS) {
  const mark = stale.some((entry) => entry.tier === tier) ? '→' : '='
  console.log(
    `${tier.padEnd(7)} ${table.tiers[tier].padEnd(20)} ${mark} ${newest[tier] ?? '(not listed)'}`,
  )
}

if (missing.length) {
  console.error(`\nThe source lists no current model for: ${missing.join(', ')}`)
  process.exit(2)
}

if (!stale.length) {
  console.log('\nEvery tier names the newest model.')
  process.exit(0)
}

if (mode === 'write') {
  for (const entry of stale) table.tiers[entry.tier] = entry.newest
  writeFileSync(PATH, `${JSON.stringify(table, null, 2)}\n`)
  console.log(`\nUpdated ${stale.map((entry) => `${entry.tier} → ${entry.newest}`).join(', ')}.`)
  console.log('Open a PR; after it merges, run /routines sync in each repo.')
  process.exit(0)
}

console.log(`\n${stale.length} tier(s) behind. bun run routines:models --write moves them.`)
process.exit(mode === 'check' ? 1 : 0)
