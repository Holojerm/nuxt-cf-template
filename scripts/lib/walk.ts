// The one directory walker the gates share. It takes absolute directories (each
// gate derives its own from its checkout) and knows nothing about the repo.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface WalkOptions {
  /** Keep only files whose name ends in one of these. Default: every file. */
  extensions?: readonly string[]
  /** Entry names (file or directory) to leave out, decided by name alone. */
  skip?: (name: string) => boolean
  /** Return [] for a directory that does not exist, instead of throwing. */
  missingOk?: boolean
}

export function walk(dir: string, options: WalkOptions = {}): string[] {
  const { extensions, skip, missingOk } = options
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (missingOk) return []
    throw error
  }
  const found: string[] = []
  for (const name of names) {
    if (skip?.(name)) continue
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue // a dangling symlink is not a file to scan
    }
    if (stat.isDirectory()) found.push(...walk(full, options))
    else if (stat.isFile() && (!extensions || extensions.some((ext) => name.endsWith(ext)))) {
      found.push(full)
    }
  }
  return found
}
