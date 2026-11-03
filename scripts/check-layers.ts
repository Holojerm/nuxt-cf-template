// Vendored-layer gate — run with `bun run layers:check`, wired into `bun run ci`.
//
// Every layer in layers.lock.json must exist and hash to what layers:pull
// recorded. An edited vendored file is a fork silently diverging from the
// template inside code that looks like the template's, which is exactly the
// drift layers exist to end. Layers under layers/ that the lock doesn't name
// are this repo's own and are not checked.
//
//   bun run layers:check            # offline, what CI runs
//   bun run layers:check --remote   # also re-download each sha and compare
//
// --remote proves the recorded hash really is the template's content at that
// commit, not just that the copy is unchanged since it was pulled.
//
// Boundaries. A layer that reaches into another layer cannot be vendored without
// it, so: no layer imports another layer, and (in the template, where every
// layer is authored here) core imports none. Features meet at core's seams
// (server/utils/extensions.ts and its siblings). Tests are exempt: a test may
// drive two layers together to pin how they fit. The app schema's re-export of
// each layer's tables is the one composition root. In a fork only the vendored
// layers are checked, since its own domain layers may use any of them, and core
// may import them.
//
// Which repo is the template is decided by fleet.json › template.syncedSha
// (null there, a commit in a fork), not by an empty lock: a fork that vendors
// nothing but owns `layers/<domain>/` has an empty lock too. A fork whose
// manifest still says null is judged as the template until its first sync
// records a sha.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

import {
  downloadRepo,
  hashLayer,
  isTemplateRepo,
  LAYERS_DIR,
  LOCK_FILE,
  readLock,
  ROOT,
  TEMPLATE_LAYERS,
} from './lib/layers'

const REMEDY =
  'Layers meet at core seams, never by importing each other (docs: .claude/docs/patterns.md, "Other seams"). Vendored layers are not edited in place. Shadow the component, page or route from the app, use an extension point (server/utils/extensions.ts), or change it in the template and run `bun run layers:pull <name>`.'

const lock = readLock()
const names = Object.keys(lock.layers)
const remote = process.argv.includes('--remote')
const problems: string[] = []

for (const name of names) {
  const dir = join(LAYERS_DIR, name)
  const entry = lock.layers[name]!
  if (!existsSync(dir)) {
    problems.push(
      `layers/${name} is in ${relative(ROOT, LOCK_FILE)} but missing — run \`bun run layers:pull ${name}\``,
    )
    continue
  }
  if (hashLayer(dir) !== entry.hash) {
    problems.push(`layers/${name} no longer matches ${lock.repo}@${entry.sha.slice(0, 7)}`)
  }
}

// ── Boundaries ───────────────────────────────────────────────────────────────
const SOURCE = /\.(ts|vue|mts)$/

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'test' || entry.startsWith('.')) return []
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? sourceFiles(path) : SOURCE.test(entry) ? [path] : []
  })
}

/** The layer a module specifier points into, or null (a package, core, or the same file tree). */
function layerOf(specifier: string, from: string): string | null {
  const alias = /^#layers\/([^/]+)/.exec(specifier)
  if (alias) return alias[1]!
  if (!specifier.startsWith('.')) return null
  const target = relative(LAYERS_DIR, resolve(dirname(from), specifier))
  if (target.startsWith('..')) return null
  return target.split(sep)[0] ?? null
}

function importsOf(file: string): string[] {
  // Code only: a comment may name a layer path without importing it.
  const code = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  return [
    ...code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|declare module\s+)['"]([^'"]+)['"]/g),
  ].map((m) => m[1]!)
}

const templateMode = isTemplateRepo()
const layerNames = templateMode
  ? readdirSync(LAYERS_DIR).filter((d) => statSync(join(LAYERS_DIR, d)).isDirectory())
  : names
if (templateMode) {
  // scripts/lib/layers.ts › TEMPLATE_LAYERS is what a fork's reference gate
  // treats as "a layer the template has, which this fork left out".
  const missing = layerNames.filter((name) => !TEMPLATE_LAYERS.includes(name))
  const stale = TEMPLATE_LAYERS.filter((name) => !layerNames.includes(name))
  for (const name of missing)
    problems.push(`layers/${name} is not in TEMPLATE_LAYERS (scripts/lib/layers.ts): add it`)
  for (const name of stale)
    problems.push(
      `TEMPLATE_LAYERS (scripts/lib/layers.ts) names ${name}, but layers/${name} does not exist`,
    )
}
for (const name of layerNames) {
  for (const file of sourceFiles(join(LAYERS_DIR, name))) {
    for (const specifier of importsOf(file)) {
      const target = layerOf(specifier, file)
      if (target && target !== name) {
        problems.push(
          `${relative(ROOT, file)} imports layers/${target} (${specifier}). A layer never imports another layer: go through a core seam`,
        )
      }
    }
  }
}
if (templateMode) {
  // The composition root re-exports every layer's tables; nothing else in core may name a layer.
  const COMPOSITION_ROOT = join(ROOT, 'server/db/schema.ts')
  for (const dir of ['server', 'app', 'shared']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      if (file === COMPOSITION_ROOT) continue
      for (const specifier of importsOf(file)) {
        const target = layerOf(specifier, file)
        if (target) {
          problems.push(
            `${relative(ROOT, file)} imports layers/${target} (${specifier}). Core never imports a layer: register through a seam`,
          )
        }
      }
    }
  }
}

if (remote && names.length) {
  const work = mkdtempSync(join(tmpdir(), 'layers-check-'))
  try {
    const checkouts = new Map<string, string>()
    for (const name of names) {
      const { sha, hash } = lock.layers[name]!
      let checkout = checkouts.get(sha)
      if (!checkout) {
        const into = mkdtempSync(join(work, 'repo-'))
        checkout = await downloadRepo(lock.repo, sha, into)
        checkouts.set(sha, checkout)
      }
      const upstream = join(checkout, 'layers', name)
      if (!existsSync(upstream))
        problems.push(`${lock.repo}@${sha.slice(0, 7)} has no layers/${name}`)
      else if (hashLayer(upstream) !== hash)
        problems.push(
          `layers/${name}: lock hash is not the template's content at ${sha.slice(0, 7)}`,
        )
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (problems.length) {
  console.error('\nlayers:check failed\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n  → ${REMEDY}\n`)
  process.exit(1)
}

const scope = remote ? ', verified against the template' : ''
console.info(
  `layers:check — ${names.length} vendored layer(s) match the lock${scope}; ${layerNames.length} layer(s) respect the import boundaries`,
)
