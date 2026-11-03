// Shared by scripts/layers-pull.ts and scripts/check-layers.ts.
//
// A vendored layer is a copy of `layers/<name>/` from the template at one
// commit, committed into this repo. Nuxt auto-registers everything under
// `layers/`, so a vendored layer behaves exactly like one authored here.
// Vendoring rather than `extends: ['github:…']` is deliberate: NuxtHub builds
// its merged schema types with tsdown, which leaves anything under
// node_modules (where remote layers land) untyped.
//
// layers.lock.json records, per vendored layer, the commit it came from and a
// content hash taken at pull time. The hash is what lets layers:check prove
// offline that nobody edited the copy.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const ROOT = resolve(import.meta.dir, '../..')
export const LAYERS_DIR = join(ROOT, 'layers')
export const LOCK_FILE = join(ROOT, 'layers.lock.json')
export const DEFAULT_REPO = 'Holojerm/nuxt-cf-template'

/**
 * Every layer the template ships. A fork may vendor any subset, so a comment or
 * doc of the template's that names `layers/<one of these>/...` is true in the
 * template and merely points at a layer the fork left out in a fork. The
 * reference gate reads this list to tell that apart from a typo.
 * `layers:check` fails in the template if it drifts from `layers/` on disk.
 */
export const TEMPLATE_LAYERS: readonly string[] = [
  'billing',
  'feedback',
  'files',
  'referral',
  'social',
]

/**
 * Is this checkout the template itself (as opposed to a fork of it)?
 *
 * The signal is `fleet.json › template.syncedSha`: null in the template, which
 * has no upstream, and the template commit a fork last synced to once it has
 * one. An empty `layers.lock.json` is NOT the signal: a fork that vendors
 * nothing but owns its own `layers/<domain>/` has an empty lock too, and
 * treating it as the template made every import of its own layer a violation.
 * Without a readable fleet.json the lock is the fallback, since a repo with no
 * manifest has nothing else to go on.
 */
export function isTemplateRepo(root: string = ROOT): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as {
      template?: { syncedSha?: string | null } | null
    }
    return !manifest.template?.syncedSha
  } catch {
    return Object.keys(readLock().layers).length === 0
  }
}

export interface LockedLayer {
  /** What was asked for (a branch, tag or sha), kept so a re-pull can follow it. */
  ref: string
  sha: string
  hash: string
}

export interface LayersLock {
  _comment?: string
  repo: string
  layers: Record<string, LockedLayer>
}

const LOCK_COMMENT =
  'Written by `bun run layers:pull`. Each entry is a layer copied from `repo` at `sha`; `hash` fingerprints the copy so `bun run layers:check` fails if anyone edits it. Change behaviour by shadowing a component/page/route from the app, through an extension point, or upstream in the template, then re-pull. Commit it.'

/**
 * `layers/<name>/<sub>` for every layer authored in this repo (not in the lock)
 * that has one. The scanning gates (design:check, seo:check) walk these beside
 * the app's own directory, so moving product code into a layer drops no check.
 * Vendored layers are the template's, which gates them itself.
 */
export function ownLayerDirs(sub: string): string[] {
  if (!existsSync(LAYERS_DIR)) return []
  const vendored = new Set(Object.keys(readLock().layers))
  return readdirSync(LAYERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !vendored.has(entry.name))
    .map((entry) => join(LAYERS_DIR, entry.name, sub))
    .filter((dir) => existsSync(dir))
}

/** Files that never belong to a layer, whatever the OS left behind. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db'])

export function readLock(): LayersLock {
  if (!existsSync(LOCK_FILE)) return { repo: templateRepo(), layers: {} }
  return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as LayersLock
}

export function writeLock(lock: LayersLock): void {
  const layers = Object.fromEntries(
    Object.entries(lock.layers).sort(([a], [b]) => a.localeCompare(b)),
  )
  const body = { _comment: LOCK_COMMENT, repo: lock.repo, layers }
  writeFileSync(LOCK_FILE, `${JSON.stringify(body, null, 2)}\n`)
}

/** The template this repo was forked from, per fleet.json; the template itself otherwise. */
function templateRepo(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'fleet.json'), 'utf8')) as {
      template?: { repo?: string } | null
    }
    return manifest.template?.repo ?? DEFAULT_REPO
  } catch {
    return DEFAULT_REPO
  }
}

function listFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * sha256 over every file's repo-independent path and bytes, in sorted order.
 * Paths use `/` on every OS so a hash taken on macOS matches one taken in CI.
 */
export function hashLayer(dir: string): string {
  const hash = createHash('sha256')
  const files = listFiles(dir)
    .map((path) => ({ path, rel: relative(dir, path).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const file of files) {
    hash.update(file.rel).update('\0').update(readFileSync(file.path)).update('\0')
  }
  return hash.digest('hex')
}

/** Resolve a branch, tag or sha to a full commit sha. Public repo, no token. */
/** Without one, a stalled connection hangs `layers:pull` / `layers:check --remote` forever. */
const FETCH_TIMEOUT_MS = 60_000

export async function resolveRef(repo: string, ref: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    {
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'layers-pull' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  )
  if (!response.ok) throw new Error(`Could not resolve ${repo}@${ref}: HTTP ${response.status}`)
  return (await response.text()).trim()
}

/**
 * Download the repo at `sha` and extract it under `into`. Returns the path of
 * the extracted checkout. Uses the system `tar` (bsdtar and GNU tar both read
 * gzip) so no dependency is needed.
 */
export async function downloadRepo(repo: string, sha: string, into: string): Promise<string> {
  const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Could not download ${repo}@${sha}: HTTP ${response.status}`)
  const archive = join(into, 'repo.tar.gz')
  // Buffered, not `Bun.write(archive, response)`: streaming a Response body to
  // disk stalls at 100% CPU on a second download in one process (reproduced on
  // Bun 1.4.0, 2026-11-02), and `--all` or `--remote` downloads more than once.
  // The archive is a few MB.
  await Bun.write(archive, await response.arrayBuffer())
  const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', into])
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`)
  const top = readdirSync(into, { withFileTypes: true }).find((entry) => entry.isDirectory())
  if (!top) throw new Error(`Archive for ${repo}@${sha} was empty`)
  return join(into, top.name)
}
