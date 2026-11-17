// Vendor template layers — run with `bun run layers:pull`.
//
//   bun run layers:pull feedback               # latest template main
//   bun run layers:pull feedback --ref <ref>   # a branch, tag or sha, and follow it from now on
//   bun run layers:pull feedback --sha <sha>   # exactly this commit, still following the same ref
//   bun run layers:pull --all                  # re-pull every locked layer at its recorded ref
//
// `--ref` changes what the layer follows: the lock records it, and `--all` pulls
// that ref again. So `--ref <sha>` pins the layer to one commit for good. `--sha`
// is for the other case, a template sync that must take every layer at the one
// commit it is syncing to: it pulls that commit and leaves the recorded ref
// alone, so the next `--all` goes back to following main. Before `--sha`, three
// syncs in a row pinned a layer by accident and reset the lock by hand.
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
const shaIndex = args.indexOf('--sha')
const shaArg = shaIndex === -1 ? undefined : args[shaIndex + 1]
const valueIndexes = [refIndex, shaIndex].filter((i) => i !== -1).map((i) => i + 1)
const names = args.filter((arg, i) => !arg.startsWith('--') && !valueIndexes.includes(i))
const all = args.includes('--all')

const lock = readLock()

const requested = all ? Object.keys(lock.layers) : names
if (!requested.length || (refArg !== undefined && shaArg !== undefined)) {
  console.error(
    'Usage: bun run layers:pull <name…> [--ref <ref> | --sha <sha>] | --all [--ref <ref> | --sha <sha>]',
  )
  process.exit(1)
}
if (shaArg !== undefined && !/^[0-9a-f]{7,40}$/.test(shaArg)) {
  console.error(`--sha takes a commit sha (7–40 hex characters), not "${shaArg}"`)
  process.exit(1)
}

// One download per distinct sha, shared by every layer pulled at it.
const work = mkdtempSync(join(tmpdir(), 'layers-pull-'))
const checkouts = new Map<string, string>()

try {
  for (const name of requested) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Not a layer name: ${name}`)
    // What the layer follows from here on: unchanged by `--sha`.
    const ref = refArg ?? lock.layers[name]?.ref ?? 'main'
    const sha = await resolveRef(lock.repo, shaArg ?? ref)

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
