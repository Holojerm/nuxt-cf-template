// GET /api/fleet — business counters for the portfolio dashboard, behind a
// bearer token.
//
// Counts only, never rows: users, entitlements by status, the ops spool's
// backlog, the feedback queue. See collectFleetCounters() for what each one
// means and where a fork adds its own.
//
// Responses that are not a 200, and why each one is what it is:
//   404 — NUXT_FLEET_TOKEN is unset (or too short to be a secret). An app that
//         has not opted into the dashboard should not advertise an endpoint
//         that only ever refuses; to a scanner this route does not exist.
//   401 — a token was configured and the request did not present it. This is
//         the one case that should be loud: a wrong token on the dashboard's
//         side is a misconfiguration someone needs to see.
//
// Rotation keeps two tokens valid at once — see server/utils/fleet-auth.ts.

import { db } from '@nuxthub/db'

import { requireFleetToken } from '../utils/fleet-auth'
import { collectFleetCounters } from '../utils/fleet-status'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'fleet', limit: 60, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig(event)
  await requireFleetToken(event, {
    current: config.fleetToken,
    previous: config.fleetTokenPrevious,
  })

  return {
    schema: 1,
    timestamp: new Date().toISOString(),
    ...(await collectFleetCounters(db)),
  }
})
