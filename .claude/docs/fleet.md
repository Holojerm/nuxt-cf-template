# Fleet contract — status, manifest, ops alerts

**Load this when:** you are touching `fleet.json`, `/api/status`, `/api/fleet`, the
`ops_events` spool or its digest cron, or wiring this app into the portfolio dashboard.

Every fork of this template can be watched by one portfolio dashboard (`fleet`,
itself a fork). Three pieces, all shipped here so a fork gets them by syncing:

- **`fleet.json`** says what this app is — slug, stage, Workers, binding ids,
  crons, which optional modules it kept, which secret *names* production needs.
  Shape: `shared/utils/fleet-manifest.ts`. `bun run fleet:check` fails the build
  when it stops matching `wrangler.toml`, so it can be trusted; edit both in the
  same commit. `bun run rename` rewrites it with everything else.
- **`GET /api/status`** is public and carries no secrets: build sha, the
  migrations the repo has vs the ones production applied (`migrations.pending`
  non-empty = the deploy-before-migrate outage, live), the cron map Nitro runs.
  `GET /api/fleet` is counters only (users, entitlements by status, ops spool,
  feedback queue) behind `NUXT_FLEET_TOKEN`; 404 when unset. Both are allowlisted
  in `server/middleware/auth.ts` because the session guard must not 401 them
  first. Add a fork-specific counter to `collectFleetCounters()`'s `extra`, not
  a second endpoint.
- **Ops alerting.** Anything worth waking the owner up for calls
  `recordOpsEvent(db, { kind, detail, path })` — the error plugin already does
  for every 5xx — and `server/tasks/ops/alert.ts` drains the spool into one
  digest email every 30 minutes via the `[[send_email]] ALERT_EMAIL` binding.
  Unconfigured = one `ops_alert_unconfigured` log line per tick and nothing
  sent. Rows are marked notified only after the send resolves, so a mail
  hiccup retries instead of losing the alert. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.
