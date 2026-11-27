// Pre-deploy secret gate — the first step of `bun run deploy:ci`, run by Workers
// Builds on main after the build and before migrations.
//
// A Worker deployed without a secret it needs uploads fine and then fails on every
// request that reads it. Two forks shipped without `NUXT_APP_SECRET` this way and
// 500'd every session read for a day: `deploy:smoke` turned the build red, but by
// then the broken version was already live and it cannot roll back. This refuses to
// deploy instead, so production stays on the last version that had its secrets.
//
// The list is fleet.json › secrets (names only; values never leave Cloudflare).
// A secret is a Worker secret (`wrangler secret put`), not a build variable, so this
// asks the Worker the build is about to replace.
//
//   bun run deploy:secrets

import manifest from '../fleet.json'
import { missingSecrets, parseSecretList } from './lib/deploy-secrets'

const required: string[] = manifest.secrets ?? []
const prod = manifest.urls?.prod ?? ''
// The template itself has no Worker behind its placeholder host, same rule as deploy:smoke.
if (!required.length || !prod || new URL(prod).hostname.endsWith('example.workers.dev')) {
  console.info('deploy:secrets — skipped, no production Worker or no required secrets')
  process.exit(0)
}

// `--cwd .output` reads the wrangler.json the build generated, so this checks the
// exact Worker (and environment) the deploy step will upload to.
const proc = Bun.spawnSync(
  ['bunx', 'wrangler', '--cwd', '.output', 'secret', 'list', '--format', 'json'],
  {
    stdout: 'pipe',
    stderr: 'pipe',
  },
)
const stdout = proc.stdout.toString()
const present = proc.exitCode === 0 ? parseSecretList(stdout) : null

if (!present) {
  console.error(
    "\ndeploy:secrets failed — could not list the Worker's secrets, so the deploy is held\n",
  )
  console.error(`  ${(proc.stderr.toString() || stdout).trim().split('\n').slice(-5).join('\n  ')}`)
  console.error(
    '\n  On a Worker that does not exist yet, put its secrets first (README › Set both secrets).\n',
  )
  process.exit(1)
}

const missing = missingSecrets(required, present)
if (missing.length) {
  console.error(`\ndeploy:secrets failed — the Worker is missing ${missing.join(', ')}\n`)
  for (const name of missing) {
    console.error(`  openssl rand -base64 32 | bunx wrangler secret put ${name}`)
  }
  console.error(
    '\n  (or the real value, for a key issued elsewhere). Nothing was deployed; production is unchanged.\n',
  )
  process.exit(1)
}
console.info(`deploy:secrets — the Worker has all ${required.length} required secrets`)
