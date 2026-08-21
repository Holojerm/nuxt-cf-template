// `bun dev` — the dev server, through the portless proxy, on a hostname that is
// unique to this checkout.
//
// This wrapper exists because portless's own name resolution is static
// (`portless.name` in package.json) and its worktree prefix is branch-derived,
// which collides in three ways parallel agents hit constantly — see
// scripts/worktree-name.ts for the list and why the worktree directory is the
// right key instead.
//
// Everything else is still portless: it assigns the app port, owns the proxy,
// and runs `dev:app`. Run `bun dev:app` to bypass the proxy entirely.

import { execFileSync, spawn } from 'node:child_process'
import { basename } from 'node:path'

import pkg from '../package.json' with { type: 'json' }

import { devAppName } from './worktree-name'

/**
 * The directory name of this linked worktree, or null in the main checkout.
 *
 * A linked worktree's `.git` is a *file* pointing elsewhere, which is why
 * `--git-dir` and `--git-common-dir` diverge there and agree in a normal
 * checkout. Cheaper and more direct than parsing `git worktree list`.
 */
function worktreeDir(): string | null {
  try {
    const read = (...args: string[]) =>
      execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const gitDir = read('rev-parse', '--absolute-git-dir')
    const commonDir = read('rev-parse', '--path-format=absolute', '--git-common-dir')
    if (gitDir === commonDir) return null
    return basename(read('rev-parse', '--show-toplevel'))
  } catch {
    // Not a git checkout, or no git on PATH. Treat it as the main checkout —
    // the worst case is the name portless would have picked anyway.
    return null
  }
}

const base = pkg.portless?.name ?? pkg.name
const script = pkg.portless?.script ?? 'dev'
const name = devAppName(base, worktreeDir())

if (name !== base) {
  console.info(`portless → ${name}.localhost  (worktree; main checkout uses ${base}.localhost)`)
}

// The positional form (`portless <name> <command>`) takes the name verbatim.
// `portless run --name <name>` would *also* prepend its branch prefix on top,
// which stays unique but is not stable: switching branches inside one worktree
// would change the hostname, and a stable URL is the entire point of portless.
const child = spawn('portless', [name, 'bun', 'run', script], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
child.on('error', (error) => {
  console.error(`Could not start portless: ${error.message}`)
  console.error('Run `bun dev:app` to start the dev server without the proxy.')
  process.exit(1)
})
