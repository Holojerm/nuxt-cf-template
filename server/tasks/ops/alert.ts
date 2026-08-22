// Cron task: drain the ops spool and email a digest.
//
// Scheduled from nuxt.config.ts (SCHEDULED_TASKS → nitro.scheduledTasks) and
// matched by the [triggers] crons entry in wrangler.toml — both must agree, or
// Cloudflare delivers a cron Nitro has no task for, or Nitro waits for a cron
// that never arrives. `bun run crons:check` fails the build on either.
//
// Silence is the healthy state: with nothing spooled this is one indexed
// SELECT, one DELETE, and a return. That is what makes a tight schedule cheap.
//
// Imports are explicit for the reason server/tasks/purge-expired-tokens.ts
// spells out: a task is an untested bundling surface that runs unattended, and
// an auto-import that resolves to `undefined` here would fail every half hour
// with nobody watching.

import { db } from '@nuxthub/db'

import { FleetManifestSchema } from '#shared/utils/fleet-manifest'

import rawManifest from '../../../fleet.json'
import { getOpsMailer } from '../../utils/ops-mail'
import { drainOpsEvents } from '../../utils/ops'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const manifest = FleetManifestSchema.parse(rawManifest)

export default defineTask({
  meta: {
    name: 'ops:alert',
    description: 'Email a digest of spooled ops events, then prune old ones',
  },
  async run({ context }) {
    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const mailer = getOpsMailer(env)
    if (!mailer) {
      console.warn(JSON.stringify({ kind: 'ops_alert_unconfigured' }))
      return { result: { skipped: 'unconfigured' } }
    }

    const outcome = await drainOpsEvents(db, mailer, {
      appName: useRuntimeConfig().public.appName,
      workerName: manifest.workers[0],
    })
    // Quiet ticks stay quiet — only say something when something happened.
    if (outcome.sent || outcome.error) {
      console.warn(JSON.stringify({ kind: 'ops_alert_run', ...outcome }))
    }
    return { result: outcome }
  },
})
