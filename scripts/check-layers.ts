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

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { downloadRepo, hashLayer, LAYERS_DIR, LOCK_FILE, readLock, ROOT } from './lib/layers'

const REMEDY =
  'Vendored layers are not edited in place. Shadow the component, page or route from the app, use an extension point (server/utils/extensions.ts), or change it in the template and run `bun run layers:pull <name>`.'

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
console.info(`layers:check — ${names.length} vendored layer(s) match the lock${scope}`)
