// Mirror gate — run with `bun run mirror:check`, wired into `bun run ci`.
//
// Some rules are written twice on purpose. `mcp/` is a separate Cloudflare
// Worker with its own build and its own package.json; it cannot import the
// app's TypeScript, so the handful of rules both sides must agree on exist as
// two implementations. Every one of them carries a "if you change one, change
// the other" comment, and every one of those comments is a promise nothing
// enforces — which is exactly the kind of promise that is kept for two months.
//
// This checks the promise by BEHAVIOUR, not by text. The two copies are already
// spelled differently (the app calls normalizeEmail(), the worker inlines the
// same trim/lowercase), so comparing source strings would fail on day one and
// teach everyone to ignore it. Instead each function is extracted from its file
// and evaluated, and both are run over a shared table of addresses. If they
// ever disagree on any of them, the build fails and names the input.
//
// Why a gate script and not a test: the vitest suite runs inside workerd, which
// has no filesystem, so no test in test/ can read mcp/src at all. This runs in
// Bun, where it can.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

/**
 * Pull one `function name(...) { ... }` out of a source file by brace matching.
 *
 * A regex cannot do this — the bodies contain braces — and importing the
 * modules is not an option either: the app's module reaches for Nuxt aliases
 * and Drizzle, and the worker's for the `agents` SDK, neither of which resolves
 * from a plain script.
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`could not find function ${name}()`)

  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

/** Evaluate an extracted predicate, with any helpers it needs supplied. */
function compilePredicate(
  body: string,
  name: string,
  helpers: Record<string, unknown> = {},
): (value: string) => boolean {
  const helperNames = Object.keys(helpers)
  // TypeScript annotations are stripped by Bun's own transpiler rather than by
  // hand — these are .ts sources and `(email: string)` is not valid JS.
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${body}\nreturn ${name}`)
  const factory = new Function(...helperNames, js) as (...args: unknown[]) => (v: string) => boolean
  return factory(...helperNames.map((key) => helpers[key]))
}

interface Mirror {
  what: string
  a: { file: string; fn: string; helpers?: string[] }
  b: { file: string; fn: string; helpers?: string[] }
  /** Inputs both sides must classify identically. */
  cases: string[]
}

const MIRRORS: Mirror[] = [
  {
    what: 'deleted-account tombstone rule',
    a: { file: 'server/utils/users.ts', fn: 'isUndeliverableAddress', helpers: ['normalizeEmail'] },
    b: { file: 'mcp/src/server.ts', fn: 'isTombstoneAddress' },
    cases: [
      // The rule's whole purpose: a deleted account must not authorize anything,
      // in the app or in the MCP worker.
      'deleted-ec6f5e2c-6b0f-4a3f-9a1b-9f0a2b3c4d5e@deleted.invalid',
      'anyone@deleted.invalid',
      'anyone@some.other.invalid',
      'anyone@invalid',
      '  Deleted-X@Deleted.INVALID ',
      // …and every real address has to keep working, including the reserved TLD
      // this repo's own fixtures and dev sign-in run on.
      'ada@example.com',
      'demo@example.com',
      'not.invalid@example.com',
      'deleted-123@example.com',
      'someone@invalid.example.com',
    ],
  },
]

const problems: string[] = []

for (const mirror of MIRRORS) {
  const load = (side: Mirror['a']) => {
    const source = readFileSync(join(ROOT, side.file), 'utf8')
    const helpers = Object.fromEntries(
      (side.helpers ?? []).map((helper) => [
        helper,
        compilePredicate(extractFunction(source, helper), helper),
      ]),
    )
    return compilePredicate(extractFunction(source, side.fn), side.fn, helpers)
  }

  let a: (value: string) => boolean
  let b: (value: string) => boolean
  try {
    a = load(mirror.a)
    b = load(mirror.b)
  } catch (error) {
    problems.push(`${mirror.what}: ${String(error)}`)
    continue
  }

  for (const input of mirror.cases) {
    const left = a(input)
    const right = b(input)
    if (left !== right) {
      problems.push(
        `${mirror.what}: "${input}" → ${mirror.a.fn}=${left} but ${mirror.b.fn}=${right}\n` +
          `    ${mirror.a.file} and ${mirror.b.file} have drifted apart.`,
      )
    }
  }
}

if (problems.length === 0) {
  console.info(`mirror:check — ${MIRRORS.length} mirrored rule(s) agree`)
  process.exit(0)
}

console.error(`\nmirror:check failed — ${problems.length} problem(s)\n`)
for (const problem of problems) console.error(`  ${problem}\n`)
console.error('These rules are deliberately written twice because the MCP worker cannot')
console.error('import the app. Change one, change the other.\n')
process.exit(1)
