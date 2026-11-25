// Routine-model gate — run with `bun run routines:check`, wired into `bun run ci`.
//
// Every routine definition in `.claude/routines/` names a model tier
// (`model: opus`), and `.claude/routines/models.json` maps each tier to the
// exact ID that `/routines sync` writes into the live routine. This gate keeps
// that split honest, offline:
//
//   1. models.json has every tier, each mapped to a claude-<tier>-<version> ID.
//   2. Every definition with frontmatter has a `model:` line naming a tier,
//      never a pinned ID. A pinned ID is how a routine drifts: nothing points
//      at it when the table moves.
//
// Whether the table itself is current is a network question, so it lives in
// `bun run routines:models` (scripts/routine-models.ts), not here.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readFrontmatter } from './lib/frontmatter'
import { routineModelProblem, tableProblems } from './lib/routine-models'

const ROOT = resolve(import.meta.dir, '..')
const DIR = join(ROOT, '.claude/routines')

const problems: string[] = []

let table: unknown
try {
  table = JSON.parse(readFileSync(join(DIR, 'models.json'), 'utf8'))
} catch (error) {
  problems.push(`.claude/routines/models.json: ${(error as Error).message}`)
}
if (table !== undefined)
  for (const problem of tableProblems(table)) problems.push(`models.json: ${problem}`)

for (const file of readdirSync(DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()) {
  const raw = readFileSync(join(DIR, file), 'utf8')
  if (!raw.startsWith('---')) continue // README, _shared, routines.config: no frontmatter
  const problem = routineModelProblem(readFrontmatter(raw).model)
  if (problem) problems.push(`${file}: ${problem}`)
}

if (problems.length) {
  console.error('routines:check failed\n')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  console.error(
    '\nA routine names a tier (opus, sonnet, haiku); .claude/routines/models.json names the ID.',
  )
  process.exit(1)
}
