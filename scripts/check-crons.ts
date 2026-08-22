// Cron-parity gate — run with `bun run crons:check`, wired into `bun run ci`.
//
// A scheduled task is wired across two files that never read each other:
// `[triggers] crons` in wrangler.toml tells Cloudflare when to wake the Worker,
// and `nitro.scheduledTasks` in nuxt.config.ts tells Nitro which task to run
// when it wakes. The join is an exact string match on the cron expression, and
// a mismatch is silent in both directions — Cloudflare fires and Nitro runs
// nothing, or Nitro waits for an expression Cloudflare was never told about.
// CLAUDE.md › Gotchas has carried that warning for a while; this makes it a
// build failure instead of a paragraph.
//
// It has happened. A fork declared three scheduled tasks — a nightly backup
// among them — and shipped with no `[triggers]` block at all. Nothing ran, for
// months, and every signal said green.
//
// Rules:
//
//   1. The set of cron expressions in wrangler.toml equals the set of keys in
//      nitro.scheduledTasks. Both directions.
//   2. Every task name in that map has a file under server/tasks/ — Nitro
//      resolves `ops:alert` to server/tasks/ops/alert.ts.
//   3. If any task is scheduled, `nitro.experimental.tasks` is on, or the
//      preset's scheduled() handler never calls runCronTasks().
//
// Reading nuxt.config.ts: the map may be written inline under `scheduledTasks:`
// or hoisted to a `const SCHEDULED_TASKS = { … }` that both nitro and
// runtimeConfig reference (which is what this template does, so /api/status can
// report the same map it runs). Either is found by the scanner in
// scripts/lib/brace-match.ts; anything more dynamic than an object literal of
// string arrays fails closed with a message saying so.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { findClosing, sliceBalanced } from './lib/brace-match'

const ROOT = resolve(import.meta.dir, '..')

interface Problem {
  rule: string
  detail: string
  remedy: string
}

const problems: Problem[] = []
const report = (rule: string, detail: string, remedy: string) =>
  problems.push({ rule, detail, remedy })

// ── wrangler.toml ───────────────────────────────────────────────────────────

interface WranglerConfig {
  triggers?: { crons?: string[] }
  env?: Record<string, { triggers?: { crons?: string[] } }>
}

const wrangler = Bun.TOML.parse(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')) as WranglerConfig
const wranglerCrons = wrangler.triggers?.crons ?? []

// `triggers` is inheritable, so an environment that repeats it is overriding
// it. That is allowed, but the override has to match — the map in
// nuxt.config.ts is the same for every environment.
for (const [envName, envConfig] of Object.entries(wrangler.env ?? {})) {
  const envCrons = envConfig.triggers?.crons
  if (envCrons && !sameSet(envCrons, wranglerCrons)) {
    report(
      `[env.${envName}.triggers] differs from [triggers]`,
      `${JSON.stringify(envCrons)} vs ${JSON.stringify(wranglerCrons)}`,
      'delete the environment’s triggers block so it inherits, or make the two lists equal',
    )
  }
}

// ── nuxt.config.ts ──────────────────────────────────────────────────────────

const configSource = readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8')

/** Strip comments so an example in a doc block cannot trip a rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * The `{ … }` literal that `scheduledTasks:` resolves to, or null with a
 * reason. Follows one level of indirection: an identifier is looked up as a
 * `const` in the same file.
 */
function scheduledTasksLiteral(source: string): { literal: string } | { error: string } {
  const key = /\bscheduledTasks\s*:\s*/.exec(source)
  if (!key) return { error: 'no `scheduledTasks:` key found' }

  const valueStart = key.index + key[0].length
  if (source[valueStart] === '{') {
    const literal = sliceBalanced(source, valueStart)
    return literal ? { literal } : { error: 'unbalanced braces after `scheduledTasks:`' }
  }

  const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(valueStart))?.[0]
  if (!identifier)
    return { error: 'the value after `scheduledTasks:` is neither `{` nor an identifier' }

  const declaration = new RegExp(`\\bconst\\s+${identifier}\\b[^=]*=\\s*`).exec(source)
  if (!declaration)
    return {
      error: `\`scheduledTasks: ${identifier}\` but no \`const ${identifier}\` in nuxt.config.ts`,
    }

  const open = declaration.index + declaration[0].length
  if (source[open] !== '{') return { error: `\`const ${identifier}\` is not an object literal` }
  const literal = sliceBalanced(source, open)
  return literal ? { literal } : { error: `unbalanced braces in \`const ${identifier}\`` }
}

/** `'0 4 * * *': ['a', 'b']` entries out of the literal. */
function parseEntries(literal: string): Map<string, string[]> | { error: string } {
  const entries = new Map<string, string[]>()
  const body = literal.slice(1, -1)
  const entry = /(['"])((?:(?!\1).)+)\1\s*:\s*/g
  let match: RegExpExecArray | null
  while ((match = entry.exec(body))) {
    const expression = match[2] ?? ''
    const valueStart = match.index + match[0].length
    if (body[valueStart] !== '[') {
      return { error: `the value for "${expression}" is not an array literal` }
    }
    const close = findClosing(body, valueStart)
    if (close === -1) return { error: `unbalanced array for "${expression}"` }
    const names = [...body.slice(valueStart + 1, close).matchAll(/(['"])((?:(?!\1).)+)\1/g)].map(
      (name) => name[2] ?? '',
    )
    entries.set(expression, names)
    entry.lastIndex = close + 1
  }
  return entries
}

const stripped = stripComments(configSource)
const found = scheduledTasksLiteral(stripped)
let nitroCrons: string[] = []
let taskNames: string[] = []

if ('error' in found) {
  // No map at all is fine only if Cloudflare is not firing anything.
  if (wranglerCrons.length) {
    report(
      'nitro.scheduledTasks unreadable',
      found.error,
      'declare the map as an object literal of string arrays, inline or as a `const` in nuxt.config.ts',
    )
  }
} else {
  const entries = parseEntries(found.literal)
  if ('error' in entries) {
    report(
      'nitro.scheduledTasks unreadable',
      entries.error,
      'keep the map to string keys and arrays of string task names',
    )
  } else {
    nitroCrons = [...entries.keys()]
    taskNames = [...new Set([...entries.values()].flat())]
  }
}

// ── 1. the two lists agree ──────────────────────────────────────────────────

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item))
}

const onlyWrangler = wranglerCrons.filter((cron) => !nitroCrons.includes(cron))
const onlyNitro = nitroCrons.filter((cron) => !wranglerCrons.includes(cron))

for (const cron of onlyWrangler) {
  report(
    'cron fires with no task',
    `"${cron}" is in wrangler.toml [triggers] but not in nitro.scheduledTasks`,
    'add the same string as a key in nuxt.config.ts, or remove the trigger',
  )
}
for (const cron of onlyNitro) {
  report(
    'task scheduled but never fired',
    `"${cron}" is in nitro.scheduledTasks but not in wrangler.toml [triggers] crons`,
    'add the same string to [triggers] crons — Cloudflare does not know this schedule exists',
  )
}

// ── 2. every task has a file ────────────────────────────────────────────────

for (const name of taskNames) {
  const relativePath = `server/tasks/${name.split(':').join('/')}.ts`
  if (!existsSync(join(ROOT, relativePath))) {
    report(
      'task has no file',
      `"${name}" is scheduled but ${relativePath} does not exist`,
      'Nitro resolves `a:b` to server/tasks/a/b.ts — create it, or fix the name',
    )
  }
}

// ── 3. the task layer is on ─────────────────────────────────────────────────

if (taskNames.length && !/\btasks\s*:\s*true\b/.test(stripped)) {
  report(
    'nitro.experimental.tasks is off',
    'tasks are scheduled but the preset’s scheduled() handler will not run them',
    'set `nitro.experimental.tasks: true` in nuxt.config.ts',
  )
}

// ── report ──────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  const summary = wranglerCrons.length
    ? `${wranglerCrons.length} cron(s), ${taskNames.length} task(s), both files agree`
    : 'no crons declared'
  console.info(`crons:check — ${summary}`)
  process.exit(0)
}

console.error(`\ncrons:check failed — ${problems.length} problem(s)\n`)
for (const { rule, detail, remedy } of problems) {
  console.error(`  ${rule}`)
  console.error(`    ${detail}`)
  console.error(`    → ${remedy}\n`)
}
console.error(
  'A cron needs the same string in wrangler.toml and nuxt.config.ts — CLAUDE.md › Gotchas.\n',
)
process.exit(1)
