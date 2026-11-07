// Migration gate — run with `bun run migrations:check`, wired into `bun run ci`.
//
// Production applies server/db/migrations with `db:migrate:remote` before the new
// Worker deploys, and the tests apply the same files to a fresh D1. Neither notices a
// schema.ts edit that never got its `bun run db:generate`: the tests only fail if a
// query happens to touch the missing column, and production finds out at runtime.
//
// Rules:
//
//   1. No drift. drizzle-kit generates against a scratch copy of the migrations; any
//      file it would write means schema.ts and the migrations disagree. A rename makes
//      drizzle-kit prompt, which a closed stdin turns into an error — also drift.
//   2. New migrations are expand-only. A migration added on this branch that drops or
//      renames a table or column breaks the Worker still serving during the deploy, and
//      a SQLite table rebuild (drizzle's `__new_` pattern) under foreign keys can cascade.
//      Write `-- destructive-ok: <why>` in the file when the break is intended.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const MIGRATIONS = 'server/db/migrations'
// Inside the repo (gitignored .data/): drizzle-kit resolves --out relative to the cwd.
const SCRATCH = '.data/migrations-check'
const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX\s+\S+\s+ON)|RENAME\s+(TO|COLUMN))\b/i

const failures: string[] = []

function listAll(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: false }) as string[]
}

async function checkDrift() {
  rmSync(join(ROOT, SCRATCH), { recursive: true, force: true })
  cpSync(join(ROOT, MIGRATIONS), join(ROOT, SCRATCH), { recursive: true })
  const before = new Set(listAll(SCRATCH))

  const proc = Bun.spawn(
    [
      'bunx',
      'drizzle-kit',
      'generate',
      '--dialect',
      'sqlite',
      '--schema',
      './server/db/schema.ts',
      '--out',
      SCRATCH,
    ],
    { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => proc.kill(), 60_000)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  const added = listAll(SCRATCH).filter((file) => !before.has(file))
  rmSync(join(ROOT, SCRATCH), { recursive: true, force: true })

  if (code !== 0) {
    failures.push(
      'drizzle-kit generate failed or prompted (a rename?) — schema.ts needs a migration.',
      ...(out + err).trimEnd().split('\n').slice(-8),
    )
  } else if (added.length) {
    failures.push(
      `schema.ts has changes no migration records (drizzle-kit would write ${added.filter((f) => f.endsWith('.sql')).join(', ')}).`,
      '  Run `bun run db:generate` and commit the migration it writes.',
    )
  }
}

/** Migration files this branch adds. Needs origin/main; skipped when the clone has no such ref. */
function addedMigrations(): string[] | null {
  const base = Bun.spawnSync(['git', 'merge-base', 'HEAD', 'origin/main'], { cwd: ROOT })
  if (base.exitCode !== 0) return null
  const diff = Bun.spawnSync(
    [
      'git',
      'diff',
      '--name-only',
      '--diff-filter=A',
      base.stdout.toString().trim(),
      '--',
      `${MIGRATIONS}/*.sql`,
    ],
    { cwd: ROOT },
  )
  const untracked = Bun.spawnSync(
    ['git', 'ls-files', '--others', '--exclude-standard', '--', `${MIGRATIONS}/*.sql`],
    {
      cwd: ROOT,
    },
  )
  return [diff.stdout.toString(), untracked.stdout.toString()]
    .join('\n')
    .split('\n')
    .filter(Boolean)
}

function checkExpandOnly(files: string[]) {
  for (const file of files) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    const sql = readFileSync(path, 'utf8')
    if (/--\s*destructive-ok:\s*\S/.test(sql)) continue
    const hits = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') && DESTRUCTIVE.test(line))
    if (hits.length) {
      failures.push(
        `${file} drops or renames (${hits.length} statement(s)), e.g. ${hits[0]!.trim().slice(0, 100)}`,
        '  Ship the expand step first, or add `-- destructive-ok: <why>` to the file.',
      )
    }
  }
}

await checkDrift()
const added = addedMigrations()
if (added) checkExpandOnly(added)

if (failures.length) {
  console.error('\nmigrations:check failed\n')
  for (const line of failures) console.error(`  ${line}`)
  console.error('')
  process.exit(1)
}
console.info(
  `migrations:check — schema.ts matches ${MIGRATIONS}${added ? `; ${added.length} new migration(s) expand-only` : '; no origin/main, expand-only check skipped'}`,
)
