// Fork-without-the-layer gate — run with `bun run ci:forkless`.
//
// Billing, referral and lifecycle email are optional: a fork that does not want
// one must be able to leave it out and keep every gate green with NO local
// patch (no `refs-check-ignore` on a comment that names the missing layer, no
// stub file standing in for a deleted module, no edit to a template script).
// That is a promise about the template's own files, and nothing but building
// the fork proves it, so this builds it: each scenario copies the repo into a
// temp dir, deletes what that fork would not have, applies only the edits
// TEARDOWN.md tells a fork to make, and runs the gates there.
//
//   bun run ci:forkless                  # every scenario
//   bun run ci:forkless no-billing       # one scenario (substring match)
//   bun run ci:forkless --keep           # leave the temp dirs for inspection
//   bun run forkless:check               # --fast: scripts only, what `bun run ci` runs
//
// A scenario's `expect: 'fail'` runs prove a gate still bites: a mode switch
// that makes a check pass everywhere is the failure this guards against.
//
// Cost: a copy plus the checks is a few seconds; the typecheck scenario adds
// `nuxt typecheck` on the copy. It is its own script rather than part of
// `bun run ci` so the deploy gate stays fast.

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { hashLayer, TEMPLATE_LAYERS } from './lib/layers'

const ROOT = resolve(import.meta.dir, '..')
const keep = process.argv.includes('--keep')
const fast = process.argv.includes('--fast')
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))

/** Tool caches inside node_modules that a copy must not share with the parent. */
const CACHES = new Set(['.cache', '.vite', '.vite-temp'])

/** Never copied: rebuilt, installed, or per-checkout. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.nuxt',
  '.output',
  '.data',
  '.wrangler',
  '.worktrees',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
])

interface Check {
  label: string
  cmd: string[]
  /** 'pass' (default) or 'fail' (the gate must reject this fork). */
  expect?: 'pass' | 'fail'
  /** For expect 'fail': text the rejection must contain. */
  includes?: string
  /**
   * Typecheck only: files a fork edits by hand (TEARDOWN.md names them), whose
   * errors are expected. Any error anywhere else fails the check.
   */
  allowErrorsIn?: string[]
  /** Slow (a typecheck, the unit tests, a browser-suite listing): skipped by --fast. */
  heavy?: boolean
}

interface Scenario {
  name: string
  /** What this fork is, for the report. */
  about: string
  /** Vendor the remaining layers and record a template sha. Default true; false judges the copy as the template. */
  fork?: boolean
  /** Layers recorded in layers.lock.json. Default: every template layer still on disk. */
  vendor?: (dir: string) => string[]
  prepare: (dir: string) => void
  checks: Check[]
}

const bun = process.execPath

// ── Edits a fork makes (the same ones TEARDOWN.md lists) ─────────────────────

function remove(dir: string, ...paths: string[]) {
  for (const path of paths) rmSync(join(dir, path), { recursive: true, force: true })
}

function edit(dir: string, path: string, change: (source: string) => string) {
  const file = join(dir, path)
  const before = readFileSync(file, 'utf8')
  const after = change(before)
  if (after === before)
    throw new Error(`forkless: edit to ${path} changed nothing — update the scenario`)
  writeFileSync(file, after)
}

function dropSchemaExport(dir: string, layer: string) {
  edit(dir, 'server/db/schema.ts', (source) =>
    source.replace(
      new RegExp(`^export \\* from '../../layers/${layer}/server/db/schema'\\n`, 'm'),
      '',
    ),
  )
}

const LIFECYCLE = [
  'server/utils/lifecycle.ts',
  'server/utils/lifecycle-emails.ts',
  'server/utils/lifecycle-steps.ts',
  'server/utils/lifecycle-app-steps.ts',
  'server/tasks/lifecycle-email.ts',
  'test/lifecycle.test.ts',
]

const withoutBilling = (dir: string) => {
  remove(dir, 'layers/billing', '.claude/docs/billing.md')
  dropSchemaExport(dir, 'billing')
  // TEARDOWN.md, "Remove billing entirely", step 3: dashboard.vue and the files
  // page name the `subscription` route middleware, which was billing's.
  writeFileSync(
    join(dir, 'app/middleware/subscription.ts'),
    'export default defineNuxtRouteMiddleware(() => {})\n',
  )
}
const withoutReferral = (dir: string) => remove(dir, 'layers/referral', '.claude/docs/referral.md')
const withoutLifecycle = (dir: string) => remove(dir, ...LIFECYCLE)

const layersCheck: Check = { label: 'layers:check', cmd: [bun, 'run', 'scripts/check-layers.ts'] }
const mirrorCheck: Check = {
  label: 'mirror:check (mirrors + reference resolution)',
  cmd: [bun, 'run', 'scripts/check-mirrors.ts'],
}
const cronsCheck: Check = { label: 'crons:check', cmd: [bun, 'run', 'scripts/check-crons.ts'] }
const browserSuites: Check = {
  label: 'playwright config loads and lists the specs (no dangling import)',
  cmd: [bun, 'x', 'playwright', 'test', '--list'],
  heavy: true,
}
const unitTests: Check = { label: 'vitest', cmd: [bun, 'x', 'vitest', 'run'], heavy: true }

/**
 * The app files TEARDOWN.md ("Remove billing entirely", step 5) tells a fork to
 * edit by hand: they render billing's composables and fields, which are gone with
 * the layer. Everything else must typecheck as shipped.
 */
const BILLING_UI = [
  'app/components/Auth/UserMenu.vue',
  'app/layouts/default.vue',
  'app/pages/account.vue',
  'app/pages/admin/users/[id].vue',
  'app/pages/index.vue',
]
const typecheck = (allowErrorsIn: string[] = []): Check => ({
  label: 'typecheck',
  cmd: [bun, 'x', 'nuxt', 'typecheck'],
  allowErrorsIn,
  heavy: true,
})

const gates = [layersCheck, mirrorCheck]

/** A comment in a core file, appended: the smallest edit that adds one reference. */
const addComment = (dir: string, file: string, text: string) =>
  edit(dir, file, (source) => `${source}// ${text}\n`)

const scenarios: Scenario[] = [
  {
    name: 'no-referral',
    about: 'billing vendored, referral left out',
    prepare: withoutReferral,
    checks: [
      ...gates,
      typecheck(['app/pages/account.vue', 'app/pages/admin/users/[id].vue']),
      unitTests,
    ],
  },
  {
    name: 'no-billing-no-referral',
    about: 'neither billing nor referral (a free product)',
    prepare: (dir) => {
      withoutReferral(dir)
      withoutBilling(dir)
    },
    checks: [...gates, typecheck(BILLING_UI), browserSuites, unitTests],
  },
  {
    name: 'no-lifecycle',
    about: 'no billing, no referral, no lifecycle email: core compiles with no lifecycle.ts at all',
    prepare: (dir) => {
      withoutReferral(dir)
      withoutBilling(dir)
      withoutLifecycle(dir)
      // The documented edits (TEARDOWN.md, "Lifecycle email").
      edit(dir, 'nuxt.config.ts', (source) =>
        source
          .replace("['purge-expired-tokens', 'lifecycle-email']", "['purge-expired-tokens']")
          .replace(/;\s*then\n\/\/\s+lifecycle email, server\/tasks\/lifecycle-email\.ts/, ''),
      )
      edit(dir, '.claude/docs/email.md', (source) =>
        source.replace(/\n## Lifecycle email\n[\s\S]*$/, '\n'),
      )
      // TEARDOWN.md is the checklist a fork finishes and deletes; its rows name the
      // files of every subsystem a fork might have removed.
      remove(dir, 'TEARDOWN.md')
      edit(dir, '.claude/docs/patterns.md', (source) =>
        source.replace(/^\| Lifecycle step \|.*\n/m, ''),
      )
    },
    checks: [...gates, cronsCheck, typecheck(BILLING_UI), unitTests],
  },
  // ── The gates still bite ───────────────────────────────────────────────────
  {
    name: 'omitted-layer-typo-fails',
    about: 'a comment naming layers/biling (not a template layer) is still a dead reference',
    prepare: (dir) => {
      withoutReferral(dir)
      addComment(dir, 'server/utils/hash.ts', 'See `layers/biling/server/utils/entitlements.ts`.')
    },
    checks: [
      { ...mirrorCheck, expect: 'fail', includes: 'layers/biling/server/utils/entitlements.ts' },
    ],
  },
  {
    name: 'present-layer-missing-file-fails',
    about: 'a path inside a layer the fork DOES have is checked as before',
    prepare: (dir) => {
      withoutReferral(dir)
      addComment(dir, 'server/utils/hash.ts', 'See `layers/billing/server/utils/no-such-file.ts`.')
    },
    checks: [
      { ...mirrorCheck, expect: 'fail', includes: 'layers/billing/server/utils/no-such-file.ts' },
    ],
  },
  {
    name: 'billing-pins-still-bite',
    about: 'with layers/billing present the access-predicate pins are enforced',
    prepare: (dir) => {
      withoutReferral(dir)
      edit(dir, 'layers/billing/server/utils/entitlements.ts', (source) =>
        source.replace(
          "export const ACTIVE_STATUSES = ['active', 'trialing']",
          "export const ACTIVE_STATUSES = ['active']",
        ),
      )
    },
    fork: false,
    checks: [{ ...mirrorCheck, expect: 'fail', includes: 'access predicate' }],
  },
  // ── layers:check: which repo is the template ───────────────────────────────
  {
    name: 'fork-owned-layer-imported-by-core',
    about:
      'a fork with an EMPTY lock and its own layers/domain that declared core files import passes',
    vendor: () => [],
    prepare: (dir) => ownLayer(dir),
    checks: [layersCheck],
  },
  {
    name: 'template-rejects-core-importing-a-layer',
    about: 'the same layout with fleet.json › template.syncedSha null is the template, and fails',
    fork: false,
    prepare: (dir) => ownLayer(dir),
    checks: [{ ...layersCheck, expect: 'fail', includes: 'Core never imports a layer' }],
  },
  {
    name: 'template-layer-list-drift',
    about: 'a layer on disk that TEMPLATE_LAYERS does not name fails in the template',
    fork: false,
    prepare: (dir) => {
      mkdirSync(join(dir, 'layers/surprise'), { recursive: true })
      writeFileSync(join(dir, 'layers/surprise/nuxt.config.ts'), 'export default {}\n')
    },
    checks: [{ ...layersCheck, expect: 'fail', includes: 'is not in TEMPLATE_LAYERS' }],
  },
]

/** `layers/domain`, fork-owned, imported by a core file (the way a fork declares it). */
function ownLayer(dir: string) {
  mkdirSync(join(dir, 'layers/domain/server/utils'), { recursive: true })
  writeFileSync(join(dir, 'layers/domain/server/utils/domain.ts'), 'export const DOMAIN = 1\n')
  writeFileSync(
    join(dir, 'server/utils/domain-glue.ts'),
    "import { DOMAIN } from '../../layers/domain/server/utils/domain'\n\nexport const GLUE = DOMAIN\n",
  )
}

// ── Making the copy a fork ───────────────────────────────────────────────────

/**
 * What `bun run layers:pull` leaves behind: every layer still on disk recorded in
 * layers.lock.json (hash and all) and a template sha in fleet.json, which is
 * what makes the repo a fork rather than the template. Done by hand here
 * because the real thing downloads from GitHub.
 */
function becomeAFork(dir: string, vendored: string[]) {
  const layers = Object.fromEntries(
    vendored.map((name) => [
      name,
      { ref: 'main', sha: '0'.repeat(40), hash: hashLayer(join(dir, 'layers', name)) },
    ]),
  )
  writeFileSync(
    join(dir, 'layers.lock.json'),
    `${JSON.stringify({ repo: 'Holojerm/nuxt-cf-template', layers }, null, 2)}\n`,
  )
  edit(dir, 'fleet.json', (source) => source.replace('"syncedSha": null', '"syncedSha": "0000000"'))
  // A fork owns its README and AGENTS.md; the template's describe the template.
  // The docs under .claude/docs/ link back to AGENTS.md, so it stays, empty.
  remove(dir, 'README.md')
  writeFileSync(join(dir, 'AGENTS.md'), '# Fork\n')
}

// ── Runner ───────────────────────────────────────────────────────────────────

function copyRepo(into: string) {
  cpSync(ROOT, into, {
    recursive: true,
    filter: (source) => {
      const parts = source.slice(ROOT.length + 1).split('/')
      return !SKIP.has(parts[0] ?? '') && !parts.includes('node_modules')
    },
  })
  linkModules(join(ROOT, 'node_modules'), join(into, 'node_modules'))
  if (existsSync(join(ROOT, 'mcp/node_modules'))) {
    mkdirSync(join(into, 'mcp'), { recursive: true })
    symlinkSync(join(ROOT, 'mcp/node_modules'), join(into, 'mcp/node_modules'))
  }
}

/**
 * The copy resolves packages through the original install, EXCEPT what `nuxt
 * prepare` generates there. NuxtHub writes `@nuxthub/db` (the merged schema
 * module and its types), `kv` and `blob` into node_modules from the repo that ran
 * prepare. A symlinked node_modules made every copy overwrite the parent's, and
 * each other's: a copy that still has billing typechecked against the schema a
 * billing-less sibling had just written ("DrizzleD1Database<…/node_modules/
 * @nuxthub/db/schema> is not assignable to <…/server/db/schema>"), depending on
 * which finished first. So `@nuxthub` is a real directory per copy (core included,
 * so its own `@nuxthub/db` imports resolve to the copy's), the tool caches are
 * left to be created fresh, and everything else is a symlink to the shared install.
 */
function linkModules(from: string, into: string) {
  mkdirSync(into, { recursive: true })
  for (const entry of readdirSync(from)) {
    if (CACHES.has(entry)) continue
    if (entry === '@nuxthub') cpSync(join(from, entry), join(into, entry), { recursive: true })
    else symlinkSync(join(from, entry), join(into, entry))
  }
}

async function run(dir: string, check: Check): Promise<string | null> {
  const child = Bun.spawn(check.cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const result = { exitCode }
  const output = `${stdout}${stderr}`
  if (check.allowErrorsIn) {
    // vue-tsc prints `path(line,col): error TSxxxx: …`.
    const failing = [...output.matchAll(/^(\S+?)\(\d+,\d+\): error TS\d+/gm)].map((m) => m[1]!)
    const unexpected = [...new Set(failing)].filter((file) => !check.allowErrorsIn!.includes(file))
    if (unexpected.length)
      return `${check.label}: errors outside the files TEARDOWN.md names\n  ${unexpected.join('\n  ')}\n${output}`
    if (result.exitCode !== 0 && !failing.length)
      return `${check.label} failed without a type error\n${output}`
    return null
  }
  const expectFail = check.expect === 'fail'
  if (expectFail) {
    if (result.exitCode === 0) return `${check.label}: passed, but this fork must be rejected`
    if (check.includes && !output.includes(check.includes))
      return `${check.label}: rejected, but not for "${check.includes}"\n${output}`
    return null
  }
  return result.exitCode === 0 ? null : `${check.label} failed\n${output}`
}

const selected = scenarios.filter(
  (scenario) => !filters.length || filters.some((filter) => scenario.name.includes(filter)),
)
const base = mkdtempSync(join(tmpdir(), 'forkless-'))

/**
 * Typecheck, the unit tests and the browser listing each start their own worker
 * pools (workerd, vue-tsc). Three scenarios doing that at once starved a loaded
 * machine badly enough that vitest gave up starting its runner ("Timeout starting
 * cloudflare-pool runner"), so the heavy checks queue behind one another while the
 * cheap gates of every scenario still run alongside.
 */
let heavyQueue: Promise<unknown> = Promise.resolve()
function oneHeavyAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = heavyQueue.then(task)
  heavyQueue = result.catch(() => {})
  return result
}

// Scenarios are independent copies, so they run side by side: the wall time is
// the slowest one, not the sum.
async function runScenario(scenario: Scenario): Promise<string | null> {
  const dir = join(base, scenario.name)
  const started = performance.now()
  copyRepo(dir)
  scenario.prepare(dir)
  if (scenario.fork !== false) {
    const vendored =
      scenario.vendor?.(dir) ??
      readdirSync(join(dir, 'layers')).filter((name) => TEMPLATE_LAYERS.includes(name))
    becomeAFork(dir, vendored)
  }
  const problems: string[] = []
  // Within a scenario the checks stay in order: they share one directory, and a
  // typecheck and a test run would both rewrite its .nuxt.
  for (const check of scenario.checks.filter((check) => !(fast && check.heavy))) {
    const problem = check.heavy
      ? await oneHeavyAtATime(() => run(dir, check))
      : await run(dir, check)
    if (problem) problems.push(problem)
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.info(
    `  ${problems.length ? '✗' : '✓'} ${scenario.name} — ${scenario.about} — ${seconds}s`,
  )
  return problems.length ? `${scenario.name} (${scenario.about})\n${problems.join('\n')}` : null
}

/**
 * A digest of what NuxtHub generates inside node_modules (the schema module and the
 * db/kv/blob typings, derived from whichever repo ran `nuxt prepare`). The copies
 * must never write there: see copyRepo().
 */
function generatedDigest(): string {
  const hash = createHash('sha256')
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else hash.update(path).update(readFileSync(path))
    }
  }
  for (const name of ['db', 'kv', 'blob']) walk(join(ROOT, 'node_modules/@nuxthub', name))
  return hash.digest('hex')
}

const generatedBefore = generatedDigest()
let failures: string[] = []
try {
  failures = (await Promise.all(selected.map(runScenario))).filter((f): f is string => !!f)
  if (generatedDigest() !== generatedBefore)
    failures.push(
      'isolation: a scenario wrote to this repo’s node_modules/@nuxthub (the generated schema ' +
        'module). Every copy must have its own, or one fork’s typecheck sees another’s schema.',
    )
} finally {
  if (keep) console.info(`kept ${base}`)
  else rmSync(base, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nci:forkless failed\n\n${failures.join('\n\n')}\n`)
  process.exit(1)
}
console.info(
  `ci:forkless — ${selected.length} fork scenario(s) pass their gates with no local patch`,
)
