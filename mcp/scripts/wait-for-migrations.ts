// Runs before `wrangler deploy` in this worker's own Workers Build: waits until
// the app's migrations are applied to the production database.
//
// This worker and the app share one D1 database, and the app's build is the
// one that migrates it (`bun run deploy:ci`). Both builds start on the same
// push, so without this the worker can go live reading a column that does not
// exist yet. Nothing to wait for is the common case and costs one command.
//
// It asks wrangler which migrations are pending rather than asking the app
// what it has deployed: the schema is the dependency, not the app's code.

import { readFileSync } from 'node:fs'

const POLL_SECONDS = 15
const DEADLINE_MINUTES = 10

// The first `"database_name"` in wrangler.jsonc is the app's database.
const database = /"database_name":\s*"([^"]+)"/.exec(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
)?.[1]
if (!database) {
  console.error('wait-for-migrations: no d1 database_name in mcp/wrangler.jsonc')
  process.exit(1)
}

function pending(): { done: boolean; output: string } {
  const run = Bun.spawnSync(
    ['bunx', 'wrangler', 'd1', 'migrations', 'list', database!, '--remote', '-c', 'wrangler.jsonc'],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' },
  )
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  return { done: run.exitCode === 0 && /no migrations to apply/i.test(output), output }
}

const deadline = Date.now() + DEADLINE_MINUTES * 60_000
for (;;) {
  const { done, output } = pending()
  if (done) {
    console.info(`wait-for-migrations: ${database} is up to date`)
    break
  }
  if (Date.now() > deadline) {
    console.error(
      `\nwait-for-migrations: ${database} still has migrations to apply after ` +
        `${DEADLINE_MINUTES} minutes. The app's build applies them; check it.\n\n${output}`,
    )
    process.exit(1)
  }
  console.info(`wait-for-migrations: ${database} has migrations pending, checking again`)
  await Bun.sleep(POLL_SECONDS * 1000)
}
