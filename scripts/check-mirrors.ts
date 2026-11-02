// Mirror gate — run with `bun run mirror:check`, wired into `bun run ci`.
//
// Two passes, one theme: promises that nothing enforces.
//
//   1. BEHAVIOURAL mirrors — rules deliberately written twice because the MCP
//      worker cannot import the app's TypeScript. Both copies are run over a
//      shared table of inputs and must agree.
//   2. REFERENCE resolution — every file, symbol, and variable a comment or doc
//      names must still exist. See scripts/lib/check-references.ts for why this
//      is narrow on purpose.
//
// Both fail the build. A stale cross-reference is not a style problem: an agent
// reads it, trusts it, and goes looking for something that is not there.
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

import { extractFunction as sliceFunction } from './lib/brace-match'
import { findDeadReferences } from './lib/check-references'

const ROOT = resolve(import.meta.dir, '..')

/**
 * Pull one `function name(...) { ... }` out of a source file.
 *
 * A regex cannot do this — the bodies contain braces — and importing the
 * modules is not an option either: the app's module reaches for Nuxt aliases
 * and Drizzle, and the worker's for the `agents` SDK, neither of which resolves
 * from a plain script.
 *
 * The scanning lives in scripts/lib/brace-match.ts, shared with
 * scripts/check-seo.ts. It returns null on unbalanced input rather than
 * guessing at a span; here that is fatal, because a half-extracted function
 * would either fail to compile below or, worse, compile into something that
 * silently disagrees with its mirror.
 */
function extractFunction(source: string, name: string): string {
  const extracted = sliceFunction(source, name)
  if (extracted === null) throw new Error(`could not extract function ${name}()`)
  return extracted
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

// ── The access predicate, pinned by text ────────────────────────────────────
// "Does this account have access" exists twice: findActiveEntitlement() in the
// billing layer (Drizzle) and the raw D1 SQL in mcp/src/server.ts. Unlike the
// rule above it cannot be evaluated here (one side needs a database), so this
// pins the clauses that make it what it is: change a status list, the `sub_`
// prefix, the LIKE escape or the expiry comparison on one side without the
// other and this fails, which is the whole point — the two disagreeing is how a
// lapsed pass kept MCP access for good, or `subs_fake` read as a subscription.
// A text check can only catch the edits that touch these fragments; it is
// the cheap half of a promise that used to be kept by a comment.

const BILLING_UTILS = 'layers/billing/server/utils'
const PREDICATE_PINS: { file: string; fragment: string; why: string }[] = [
  {
    file: `${BILLING_UTILS}/entitlements.ts`,
    fragment: "export const ACTIVE_STATUSES = ['active', 'trialing']",
    why: "statuses that grant access (the SQL's status IN ('active', 'trialing'))",
  },
  {
    file: `${BILLING_UTILS}/paddle-refs.ts`,
    fragment: "export const SUBSCRIPTION_REF_PREFIX = 'sub_'",
    why: "the prefix whose rows pass on status alone (the SQL's LIKE 'sub\\_%')",
  },
  {
    file: `${BILLING_UTILS}/entitlements.ts`,
    fragment: 'likePrefix(tables.entitlements.paddleSubscriptionId, SUBSCRIPTION_REF_PREFIX)',
    why: 'the escaped prefix match (ESCAPE) that findActiveEntitlement ORs with the expiry',
  },
  {
    file: `${BILLING_UTILS}/entitlements.ts`,
    fragment: 'gt(tables.entitlements.currentPeriodEnd, now)',
    why: "everything else must still be in its window (the SQL's current_period_end > ?3)",
  },
  {
    file: 'mcp/src/server.ts',
    fragment: "status IN ('active', 'trialing')",
    why: 'the same status list, in SQL',
  },
  {
    file: 'mcp/src/server.ts',
    fragment: "LIKE 'sub\\\\_%' ESCAPE '\\\\'",
    why: 'the same escaped prefix match, in SQL',
  },
  {
    file: 'mcp/src/server.ts',
    fragment: 'current_period_end > ?3',
    why: 'the same expiry comparison, in SQL',
  },
]

for (const pin of PREDICATE_PINS) {
  const source = readFileSync(join(ROOT, pin.file), 'utf8')
  if (!source.includes(pin.fragment)) {
    problems.push(
      `access predicate: ${pin.file} no longer contains \`${pin.fragment}\` — ${pin.why}\n` +
        `    findActiveEntitlement() and mcp/src/server.ts must still mean the same thing.`,
    )
  }
}

// ── Pass 2: reference resolution ────────────────────────────────────────────

const dead = findDeadReferences(ROOT)

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length === 0 && dead.length === 0) {
  console.info(
    `mirror:check — ${MIRRORS.length} mirrored rule(s) agree, every named reference resolves`,
  )
  process.exit(0)
}

if (problems.length > 0) {
  console.error(`\nmirror:check failed — ${problems.length} mirror problem(s)\n`)
  for (const problem of problems) console.error(`  ${problem}\n`)
  console.error('These rules are deliberately written twice because the MCP worker cannot')
  console.error('import the app. Change one, change the other.\n')
}

if (dead.length > 0) {
  console.error(`\nmirror:check failed — ${dead.length} dead reference(s)\n`)
  for (const ref of dead) {
    console.error(`  ${ref.file}:${ref.line}  \`${ref.token}\` — ${ref.why}`)
  }
  console.error(
    '\nA comment or doc names something this repo no longer contains. Fix the name,\n' +
      'or drop the reference — a confident pointer to nothing costs the next agent\n' +
      'more than no pointer at all. Deliberate exception: add `refs-check-ignore` to\n' +
      'the line.\n',
  )
}

process.exit(1)
