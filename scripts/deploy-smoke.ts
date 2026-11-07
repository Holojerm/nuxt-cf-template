// Post-deploy smoke — the last step of `bun run deploy:ci`, run by Workers Builds on main.
//
// Until this ran, a deploy that uploaded fine but served 500s (a binding missing in
// production, a module that throws at startup, a D1 that the new code cannot query) was
// green in Workers Builds and only surfaced at fleet's next 15-minute collection, or when
// a user hit it. This fails the build instead, so the red deploy is the alert.
//
// It cannot roll back — `wrangler rollback` is a human decision — and it only proves the
// Worker serves: `/` renders through SSR and `/api/health` reaches D1. Which commit is
// live is fleet's job (/api/status sits behind the fleet token on purpose).
//
//   bun run deploy:smoke             # against fleet.json › urls.prod
//   SMOKE_URL=https://… bun run deploy:smoke

import manifest from '../fleet.json'

const base = (process.env.SMOKE_URL ?? manifest.urls?.prod ?? '').replace(/\/$/, '')
// The template's placeholder host has no Worker behind it.
if (!base || new URL(base).hostname.endsWith('example.workers.dev')) {
  console.info(`deploy:smoke — skipped, no production URL (${base || 'unset'})`)
  process.exit(0)
}

const CHECKS = ['/', '/api/health']
// A fresh version reaches every edge within seconds; the budget covers a cold start.
const DEADLINE_MS = 90_000

async function probe(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { 'user-agent': 'deploy-smoke (Workers Builds)' },
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok ? null : `HTTP ${res.status}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const started = Date.now()
let failures: string[] = []
do {
  const results = await Promise.all(CHECKS.map(async (path) => [path, await probe(path)] as const))
  failures = results.filter(([, err]) => err).map(([path, err]) => `${path}: ${err}`)
  if (!failures.length) break
  await Bun.sleep(5_000)
} while (Date.now() - started < DEADLINE_MS)

if (failures.length) {
  console.error(`\ndeploy:smoke failed — ${base} is not serving after ${DEADLINE_MS / 1000}s\n`)
  for (const line of failures) console.error(`  ${line}`)
  console.error(
    '\n  The new version is live. Check `bunx wrangler tail`, then fix forward or roll back.\n',
  )
  process.exit(1)
}
console.info(`deploy:smoke — ${base} serves ${CHECKS.join(' and ')}`)
