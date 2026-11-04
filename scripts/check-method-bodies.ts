// Request-body gate — run with `bun run methods:check`, wired into `bun run ci`.
//
// Nitro's Cloudflare handler forwards a request body only for POST, PUT and
// PATCH (nitropack runtime `requestHasBody`: /post|put|patch/i). A DELETE that
// carries a body reaches the handler with none, `readBody` waits for bytes that
// never come, and workerd kills the request as hung: a 500 in production.
// `nuxt dev` runs on Node, which passes the body through, so dev and vitest are
// green. This shipped once: account deletion, which carries a typed
// confirmation, returned 500 for every user until it moved to POST.
//
// Rule: a server route whose filename method is get, head or delete does not
// read a request body. A destructive action that needs a confirmation in the
// body is a POST (POST /api/account/delete); one that needs only the URL
// (DELETE /api/files/:id) stays a DELETE.
//
// Scans server/ and every layers/*/server/ for *.get.ts, *.head.ts and
// *.delete.ts. It cannot see a body read hidden in a helper the handler calls;
// a smoke test against the built Worker is the only thing that does. Escape hatch: `methods-check-ignore`
// in a comment on the same line or the line above.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { bodyReads, isBodyless, routeMethod } from './lib/method-bodies'
import { walk } from './lib/walk'

const ROOT = resolve(import.meta.dir, '..')

const layersDir = join(ROOT, 'layers')
const roots = [
  join(ROOT, 'server'),
  ...(existsSync(layersDir)
    ? readdirSync(layersDir).map((name) => join(layersDir, name, 'server'))
    : []),
].filter((dir) => existsSync(dir))

const problems: string[] = []
let scanned = 0
for (const file of roots.flatMap((dir) => walk(dir, { skip: (name) => name === 'node_modules' }))) {
  const method = routeMethod(file)
  if (!isBodyless(method)) continue
  scanned += 1
  for (const { line, call } of bodyReads(readFileSync(file, 'utf8'))) {
    problems.push(`${relative(ROOT, file)}:${line}  ${method!.toUpperCase()} route calls ${call}()`)
  }
}

if (problems.length === 0) {
  console.info(`methods:check — ${scanned} get/head/delete route(s), none reads a body`)
  process.exit(0)
}

console.error(`\nmethods:check failed — ${problems.length} problem(s)\n`)
for (const problem of problems) console.error(`  ${problem}`)
console.error(
  '\nOn Workers a GET/HEAD/DELETE request never carries a body: the read hangs and the request\n' +
    'is killed (a 500). Rename the route to *.post.ts and call it with POST — `.claude/docs/patterns.md` › API Routes.\n',
)
process.exit(1)
