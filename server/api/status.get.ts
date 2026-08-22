// GET /api/status — what a dashboard needs to know about this deployment, in
// one public, unauthenticated, no-secrets payload.
//
// /api/health stays as it is (liveness only) and this sits beside it, because
// the two answer different questions. Health says "is the Worker up and can it
// reach D1". Status says "is what is running the thing that was meant to be
// running": which commit, which migrations production has actually applied
// against which the code expects, which crons Nitro will answer. Those are
// the questions an uptime check cannot ask and the portfolio dashboard
// (`fleet`) polls every fifteen minutes.
//
// Public on purpose. Nothing here is a secret — migration tags, a commit sha,
// cron expressions and the app's own name are all in the public repo of an
// open-source fork and in the bundle of a closed one — and the one reader that
// most needs it, an external heartbeat, must not have to hold a credential.
// Anything that IS sensitive (user counts, revenue) lives behind a bearer in
// /api/fleet instead.
//
// HTTP status: 200 with `status: 'ok'` or `'degraded'` (migrations pending —
// the app is up, just not the app the code expects), 503 with `'down'` when
// D1 is unreachable. A poller can key on the HTTP code; a human reads the
// field.

import { db } from '@nuxthub/db'
import { sql } from 'drizzle-orm'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'

import rawManifest from '../../fleet.json'
import pkg from '../../package.json'
import { compareMigrations, readAppliedMigrations, repoMigrations } from '../utils/fleet-status'

/** Bump when the shape of this payload changes incompatibly. */
export const FLEET_STATUS_SCHEMA_VERSION = 1

// Parsed once at module load. `bun run fleet:check` guarantees this passes in
// CI, so a throw here means the manifest was edited by hand after the gate —
// and failing the route loudly is better than serving a half-read manifest.
const manifest = FleetManifestSchema.parse(rawManifest)

export default defineEventHandler(async (event) => {
  // Same budget as /api/health: generous for a monitor, useless as a load generator.
  await rateLimit(event, { name: 'status', limit: 60, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig(event)

  let database: 'connected' | 'unavailable' = 'connected'
  try {
    await db.run(sql`SELECT 1`)
  } catch {
    database = 'unavailable'
  }

  const applied =
    database === 'connected' ? await readAppliedMigrations(db) : { table: null, names: [] }
  const repo = repoMigrations()
  const drift = compareMigrations(repo, applied.names)

  const status = database === 'unavailable' ? 'down' : drift.pending.length ? 'degraded' : 'ok'
  if (status === 'down') setResponseStatus(event, 503)

  return {
    schema: FLEET_STATUS_SCHEMA_VERSION,
    status,
    timestamp: new Date().toISOString(),
    app: {
      slug: manifest.slug,
      name: manifest.name,
      stage: manifest.stage,
      workers: manifest.workers,
    },
    database,
    build: {
      // Empty when neither CI nor git could supply one — reported as null so a
      // reader does not mistake '' for "the sha is the empty string".
      sha: config.public.buildSha || null,
      date: config.buildDate,
    },
    versions: {
      nuxt: pkg.dependencies.nuxt,
      wrangler: pkg.devDependencies.wrangler,
      templateRepo: manifest.template.repo,
      templateSyncedSha: manifest.template.syncedSha,
    },
    migrations: {
      repo: { head: repo.at(-1) ?? null, count: repo.length },
      applied: {
        table: applied.table,
        head: applied.names.at(-1) ?? null,
        count: applied.names.length,
      },
      pending: drift.pending,
      unknown: drift.unknown,
    },
    // The same map Nitro runs, so a reader can compare it with the triggers
    // Cloudflare reports — the cron-parity check, from the outside.
    crons: config.scheduledTasks,
  }
})
