// GET /api/ops/events — the ops spool for the ops-triage routine
// (.claude/routines/ops-triage.md), behind its own bearer, NUXT_OPS_TOKEN.
//
// Its own token, not NUXT_FLEET_TOKEN: the routine runs in a cloud
// environment the dashboard has no reason to share, and rotating one should
// not break the other. Same verdicts as /api/fleet: 404 when unset (an app
// without the routine advertises nothing), 401 on a wrong token.
//
// It also carries the two deploy facts the routine acts on, so it needs no
// second credential for /api/status: the build sha (compared with main's head
// to catch a merge whose deploy never landed) and pending migrations (a deploy
// ahead of its migrations is an outage, and retriggering it would repeat one).
//
// Rows, unlike /api/fleet's counts: `detail` is the one-line summary the
// fleet's alert email carries, truncated to 500 characters at write time,
// never a stack trace or a user's data.

import { db } from '@nuxthub/db'
import { z } from 'zod'

import { requireFleetToken } from '../../utils/fleet-auth'
import { compareMigrations, readAppliedMigrations, repoMigrations } from '../../utils/fleet-status'
import { OPS_EVENT_RETENTION_DAYS, OPS_EVENTS_READ_LIMIT, recentOpsEvents } from '../../utils/ops'

const Query = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(OPS_EVENT_RETENTION_DAYS * 24)
    .default(24),
  kind: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
})

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'ops-events', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireFleetToken(event, { current: useRuntimeConfig(event).opsToken })
  const { hours, kind } = await getValidatedQuery(event, Query.parse)

  const [events, applied] = await Promise.all([
    recentOpsEvents(db, { hours, kind }),
    readAppliedMigrations(db),
  ])
  return {
    schema: 1,
    build: { sha: useRuntimeConfig(event).public.buildSha || null },
    migrations: { pending: compareMigrations(repoMigrations(), applied.names).pending },
    hours,
    limit: OPS_EVENTS_READ_LIMIT,
    events,
  }
})
