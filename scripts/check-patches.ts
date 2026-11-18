// Fail when a `patchedDependencies` entry names a version that is not the one installed.
//
// bun applies a patch only to the exact version in its key, and skips it without a word once
// the package is upgraded. The @nuxthub/core migration-order patch ran unapplied for a release
// that way (see .claude/docs/gotchas.md). On a failure, carry the patch forward to the new
// version (`bun patch <name>`, or rename the file and the key when it still applies) or delete
// it if upstream fixed the bug.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  patchedDependencies?: Record<string, string>
}

const failures: string[] = []
for (const [key, file] of Object.entries(pkg.patchedDependencies ?? {})) {
  const at = key.lastIndexOf('@')
  const name = key.slice(0, at)
  const version = key.slice(at + 1)
  if (!existsSync(join(root, file))) failures.push(`${key}: patch file ${file} does not exist`)
  const manifest = join(root, 'node_modules', name, 'package.json')
  if (!existsSync(manifest)) {
    failures.push(`${key}: ${name} is not installed`)
    continue
  }
  const installed = (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
  if (installed !== version) {
    failures.push(`${key}: installed ${name} is ${installed}, so bun skips this patch`)
  }
}

if (failures.length) {
  console.error(`patches:check failed:\n${failures.map((f) => `  ${f}`).join('\n')}`)
  process.exit(1)
}
