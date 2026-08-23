// Reference resolution — does the thing this comment names still exist?
//
// This repo's comments are 39% of its source lines, and that density is the
// point: an agent reading a file cold gets the *why*, not just the *what*. It
// is also the failure mode. A comment that says "see server/utils/foo.ts" or
// "the same rule `isSameMailbox()` applies" is a promise nothing enforces, and
// a rename six months later turns it into a confident lie. That is strictly
// worse than no comment: an agent trusts it and goes hunting for a file that
// is not there, or worse, reasons about a rule that no longer exists.
//
// The split of CLAUDE.md into `.claude/docs/` made this urgent rather than
// theoretical — a dozen comments pointed at "CLAUDE.md › Gotchas", a heading
// that moved. Running this for the first time also found a pointer that had
// ALREADY been dead on main (`server/utils/onboarding.ts` cited reasoning
// CLAUDE.md gives for `user_signed_up`, which CLAUDE.md never mentioned).
//
// ── The rule, deliberately narrow ───────────────────────────────────────────
// A reference fails only when it resolves to NOTHING IN THIS REPO. Not "is not
// defined here" — `useFetch()` is a Nuxt auto-import and defined nowhere in
// this checkout, but it appears in the code, so it resolves. A renamed symbol
// disappears from the code entirely, which is the case worth failing on.
//
// That narrowness is what makes the gate usable. A stricter "is this the
// definition site" check would flag every framework call and teach everyone to
// ignore the output, which is how a gate dies.
//
// Comments are stripped from the corpus before the search. Otherwise a symbol
// mentioned in three comments and defined in none would vouch for itself.
//
// ── Why the `›` notation is scanned too ─────────────────────────────────────
// Backticks are not the only way this repo points at things. The other is bare
// prose — `server/utils/auth.ts › establishSession` — and for a long time the
// gate could not see a single one of them: nothing was backticked, so nothing
// was extracted, so the reference was never checked rather than checked and
// passed. That is how a dead `revokeReferralRewardForReferee` pointer survived
// in `shared/utils/referral.ts`, in billing code, on a green build.
//
// The left-hand side is what makes this safe to parse. `DESIGN.md › Accessibility`
// is a heading in a document and must be left alone; `server/utils/auth.ts ›
// establishSession` is a claim about code. Requiring a `.ts`/`.vue` file on the
// left separates the two exactly, with no list to maintain.
//
// The right-hand side must be a BARE identifier. `nuxt.config.ts ›
// runtimeConfig.buildDate` names a config path, not a symbol, and no such
// string exists in the source; accepting dotted names would fail the build on
// a correct comment, which is the one thing this gate must never do.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export interface Reference {
  file: string
  line: number
  kind: 'path' | 'symbol' | 'env'
  token: string
}

const SOURCE_DIRS = ['app', 'server', 'shared', 'scripts', 'test']
const DOC_DIRS = ['.claude/docs', '.claude/commands', '.claude/routines']
const DOC_FILES = ['CLAUDE.md', 'AGENTS.md', 'TEARDOWN.md', 'DESIGN.md', 'README.md']
const CORPUS_EXTRA = [
  'nuxt.config.ts',
  'wrangler.toml',
  '.env.example',
  'package.json',
  'content.config.ts',
]

/** Paths that only exist after a build, an install, or a dev run. */
const EPHEMERAL = [
  '.nuxt/',
  '.output/',
  '.data/',
  '.wrangler/',
  'node_modules/',
  'dist/',
  'coverage/',
]

// Files whose PATH references are templates, not pointers. Slash commands
// print the files they are about to generate (`app/pages/[feature]/index.vue`) refs-check-ignore
// and routines name files on the ops-journal branch (`journal/YYYY-MM-DD.md`); refs-check-ignore
// neither exists in this checkout and neither is a mistake. Their symbol and
// variable references are still checked — those are claims about this repo.
const PATHS_ARE_TEMPLATES = ['.claude/commands/', '.claude/routines/']

/** A token containing any of these is a placeholder, not a reference. */
const PLACEHOLDER = ['<', '>', '*', '…', '?', '|', '$', '{']

const SOURCE_EXT = ['.ts', '.vue']
const PATH_EXT =
  /\.(ts|tsx|vue|md|json|jsonc|toml|sql|css|txt|xml|svg|png|webmanifest|lock|example)$/

function walk(dir: string, exts: string[]): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'worktrees' || entry.startsWith('.git')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out = out.concat(walk(full, exts))
    else if (exts.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/**
 * Strip comments so the corpus is code only.
 *
 * Line comments are recognised only when `//` is not preceded by `:` — that
 * one guard is what stops `https://example.com` inside a string from eating
 * the rest of the line. It is a heuristic, and the direction it errs in is the
 * safe one: a missed strip leaves extra text in the corpus, which can only
 * cause a reference to resolve, never to fail.
 */
function stripComments(source: string, file: string): string {
  // `.env.example` is exempt on purpose: its variables are shipped commented
  // out, so stripping `#` lines would delete the very names it documents.
  if (file.endsWith('.example')) return source
  if (file.endsWith('.toml')) return source.replace(/^\s*#.*$/gm, '')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The comment text of a source file, as [line, text] pairs (1-indexed). */
function commentsOf(source: string): Array<[number, string]> {
  const out: Array<[number, string]> = []
  source.split('\n').forEach((line, index) => {
    const block = line.match(/^\s*(?:\*|\/\/|\/\*|<!--)\s?(.*)$/)
    if (block) {
      out.push([index + 1, block[1] ?? ''])
      return
    }
    const trailing = line.match(/(^|[^:])\/\/\s?(.*)$/)
    if (trailing) out.push([index + 1, trailing[2] ?? ''])
  })
  return out
}

/**
 * `path/to/file.ts › symbolName` — the notation backticks alone never caught. refs-check-ignore
 *
 * Deliberately conservative at both ends: a `.ts`/`.vue` path on the left (so a
 * `DESIGN.md › Heading` is not read as code), and a bare identifier on the right,
 * with `(?![\w$.])` rejecting dotted config paths. A pointer that wraps across
 * two lines simply does not match — comments are scanned a line at a time, and
 * missing a reference is the safe direction to err in.
 *
 * The marker on the first line is there because the rule is good enough to flag
 * its own documentation: `path/to/file.ts` is a shape, not a pointer.
 */
const POINTER = /([^\s`(]+\.(?:ts|vue))`?\s*›\s*`?([A-Za-z_$][\w$]*(?:\(\))?)(?![\w$.])/g

function pointersIn(text: string): Array<Pick<Reference, 'kind' | 'token'>> {
  const out: Array<Pick<Reference, 'kind' | 'token'>> = []
  for (const match of text.matchAll(POINTER)) {
    const file = (match[1] ?? '').trim()
    const symbol = (match[2] ?? '').trim()
    // Routed through classify() rather than trusted: it applies the same
    // placeholder and extension guards every other path reference gets, and it
    // drops bare `nuxt.config.ts` for the same reason a backticked one is
    // dropped — no slash, so it is not treated as a path here either.
    if (classify(file) === 'path') out.push({ kind: 'path', token: file })
    if (symbol) out.push({ kind: 'symbol', token: symbol })
  }
  return out
}

/** Backticked spans and markdown link targets — the two other ways this repo names a thing. */
function tokensIn(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/`([^`]+)`/g)) out.push((match[1] ?? '').trim())
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) out.push((match[1] ?? '').trim())
  return out
}

/** True when `refs-check-ignore` appears in the run of non-blank lines around `index`. */
function blockHasMarker(lines: string[], index: number): boolean {
  const blank = (i: number) => (lines[i] ?? '').trim() === ''
  let start = index
  while (start > 0 && !blank(start - 1)) start--
  let end = index
  while (end < lines.length - 1 && !blank(end + 1)) end++
  for (let i = start; i <= end; i++) {
    if ((lines[i] ?? '').includes('refs-check-ignore')) return true
  }
  return false
}

function classify(token: string): Reference['kind'] | null {
  if (!token || token.length > 120) return null
  if (/\s/.test(token)) return null
  if (PLACEHOLDER.some((char) => token.includes(char))) return null

  // `=` and `,` never appear in a path in this repo, but both are ordinary in a
  // URL this repo constructs — `/cdn-cgi/image/w=640,f=auto/og.png` ends in
  // `.png` and would otherwise read as a file that is not there.
  if (token.includes('=') || token.includes(',')) return null
  if (token.includes('/') && PATH_EXT.test(token)) return 'path'
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(token)) return 'env'
  if (/^[a-zA-Z_$][\w$]*\(\)$/.test(token)) return 'symbol'
  return null
}

export function collectReferences(root: string): Reference[] {
  const refs: Reference[] = []
  const seen = new Set<string>()

  // A backticked `file.ts` › `symbol()` is picked up by BOTH extractors. They
  // agree, so the only consequence is the same dead reference printed twice in
  // the report; collapse it here rather than teaching either extractor about
  // the other.
  const add = (file: string, line: number, kind: Reference['kind'], token: string) => {
    const key = `${file}:${line}:${kind}:${token}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ file, line, kind, token })
  }

  // The escape hatch is honoured anywhere in the same BLOCK — the run of
  // consecutive comment lines, or in a doc the paragraph. Prose wraps, so the
  // token and the sentence explaining why it is deliberate almost never share a
  // physical line; a line-scoped hatch would be unusable in exactly the files
  // that need it most, and an unusable hatch gets worked around instead of used.
  const push = (file: string, line: number, text: string, lines: string[]) => {
    if (blockHasMarker(lines, line - 1)) return
    for (const token of tokensIn(text)) {
      const kind = classify(token)
      if (kind) add(file, line, kind, token)
    }
    for (const pointer of pointersIn(text)) add(file, line, pointer.kind, pointer.token)
  }

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir), SOURCE_EXT)) {
      const rel = relative(root, file)
      const source = readFileSync(file, 'utf8')
      const lines = source.split('\n')
      for (const [line, text] of commentsOf(source)) push(rel, line, text, lines)
    }
  }

  const docs = [
    ...DOC_FILES.map((f) => join(root, f)),
    ...DOC_DIRS.flatMap((d) => walk(join(root, d), ['.md'])),
  ]
  for (const file of docs) {
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = relative(root, file)
    const lines = source.split('\n')
    lines.forEach((text, index) => push(rel, index + 1, text, lines))
  }

  return refs
}

/** Every identifier the repo's own code contains, comments removed. */
function buildCorpus(root: string): string {
  const files = [
    ...SOURCE_DIRS.flatMap((d) => walk(join(root, d), ['.ts', '.vue', '.json'])),
    ...walk(join(root, 'mcp/src'), ['.ts']),
    ...walk(join(root, 'server/db/migrations'), ['.sql']),
    ...CORPUS_EXTRA.map((f) => join(root, f)),
  ]
  let corpus = ''
  for (const file of files) {
    try {
      corpus += stripComments(readFileSync(file, 'utf8'), file) + '\n'
    } catch {
      /* optional file */
    }
  }
  return corpus
}

export interface DeadReference extends Reference {
  why: string
}

export function findDeadReferences(root: string): DeadReference[] {
  const refs = collectReferences(root)
  const corpus = buildCorpus(root)
  const dead: DeadReference[] = []

  for (const ref of refs) {
    if (ref.kind === 'path') {
      if (EPHEMERAL.some((prefix) => ref.token.startsWith(prefix))) continue
      if (PATHS_ARE_TEMPLATES.some((prefix) => ref.file.startsWith(prefix))) continue
      // Resolve against the referring file's own directory first — the docs in
      // .claude/docs/ reach the repo with ../../ — then against the root.
      const candidates = [
        resolve(root, dirname(ref.file), ref.token),
        resolve(root, ref.token.replace(/^\.\//, '').replace(/^\//, '')),
      ]
      if (candidates.some((path) => existsQuiet(path))) continue
      dead.push({ ...ref, why: 'no such file or directory' })
      continue
    }

    const bare = ref.token.endsWith('()') ? ref.token.slice(0, -2) : ref.token
    if (bare.length < 4) continue
    if (corpus.includes(bare)) continue
    if (declaredByADependency(root, bare)) continue
    dead.push({
      ...ref,
      why:
        ref.kind === 'symbol'
          ? 'no such symbol in this repo or its installed types'
          : 'no such variable in this repo or its installed types',
    })
  }

  return dead
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Last resort before failing a symbol: is it exported by something installed?
 *
 * `getPlatformProxy()` and `useRequestFetch()` are real APIs this repo talks
 * ABOUT without calling, so they appear in no source file here and would
 * otherwise read as renames. A grep over `node_modules` type declarations
 * settles it.
 *
 * This runs only for the handful of references the fast path could not
 * resolve — typically zero — so its ~0.5s cost never lands on a clean run.
 * With no `node_modules` present the check cannot answer, and an unanswerable
 * check must not fail the build: it returns true and the reference passes.
 */
const dependencyCache = new Map<string, boolean>()

function declaredByADependency(root: string, name: string): boolean {
  const cached = dependencyCache.get(name)
  if (cached !== undefined) return cached

  const modules = join(root, 'node_modules')
  if (!existsSync(modules)) return true

  const result = spawnSync(
    'grep',
    ['-rlq', '--include=*.d.ts', '--include=*.d.mts', '--', name, modules],
    { stdio: 'ignore', timeout: 30_000 },
  )
  // status 0 = found. Anything else (1 = absent, null = timeout) is treated as
  // absent only for status 1; a timeout must not manufacture a failure.
  const found = result.status === 0 || result.status === null
  dependencyCache.set(name, found)
  return found
}
