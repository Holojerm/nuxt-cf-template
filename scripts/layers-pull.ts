// Vendor template layers — run with `bun run layers:pull`.
//
//   bun run layers:pull feedback               # latest template main
//   bun run layers:pull feedback --ref <ref>   # a branch, tag or sha
//   bun run layers:pull --all                  # re-pull every locked layer at its recorded ref
//
// Replaces `layers/<name>/` with the template's copy at one commit and records
// that commit and a content hash in layers.lock.json. Review the diff like any
// other change: it is exactly what the template changed in that layer.

import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadRepo, hashLayer, LAYERS_DIR, readLock, resolveRef, writeLock } from './lib/layers'

const args = process.argv.slice(2)
const refIndex = args.indexOf('--ref')
const refArg = refIndex === -1 ? undefined : args[refIndex + 1]
const names = args.filter(
  (arg, i) => !arg.startsWith('--') && (refIndex === -1 || i !== refIndex + 1),
)
const all = args.includes('--all')

const lock = readLock()

const requested = all ? Object.keys(lock.layers) : names
if (!requested.length) {
  console.error('Usage: bun run layers:pull <name…> [--ref <ref>] | --all [--ref <ref>]')
  process.exit(1)
}

// One download per distinct sha, shared by every layer pulled at it.
const work = mkdtempSync(join(tmpdir(), 'layers-pull-'))
const checkouts = new Map<string, string>()

try {
  for (const name of requested) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Not a layer name: ${name}`)
    const ref = refArg ?? lock.layers[name]?.ref ?? 'main'
    const sha = await resolveRef(lock.repo, ref)

    let checkout = checkouts.get(sha)
    if (!checkout) {
      const into = join(work, sha)
      mkdirSync(into, { recursive: true })
      checkout = await downloadRepo(lock.repo, sha, into)
      checkouts.set(sha, checkout)
    }

    const source = join(checkout, 'layers', name)
    if (!existsSync(source))
      throw new Error(`${lock.repo}@${sha.slice(0, 7)} has no layers/${name}`)

    // Stage beside the target, then swap, so a failure never leaves a half-copied layer.
    const target = join(LAYERS_DIR, name)
    const staged = join(LAYERS_DIR, `.${name}.pulling`)
    mkdirSync(LAYERS_DIR, { recursive: true })
    rmSync(staged, { recursive: true, force: true })
    cpSync(source, staged, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staged, target)

    const previous = lock.layers[name]?.sha
    lock.layers[name] = { ref, sha, hash: hashLayer(target) }
    const change = previous && previous !== sha ? `${previous.slice(0, 7)} → ` : ''
    console.info(`layers/${name}: ${change}${sha.slice(0, 7)} (${ref})`)
  }
  writeLock(lock)
} catch (error) {
  console.error(`\nlayers:pull failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
