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
- **`GET /api/status`** reports build sha, the migrations the repo has vs the
  ones production applied (`migrations.pending` non-empty = the
  deploy-before-migrate outage, live), and the cron map Nitro runs. That is a
  fingerprint of the deployment, so it sits behind `NUXT_FLEET_TOKEN` like
  `GET /api/fleet` (counters only: users, entitlements by status, ops spool,
  feedback queue, and a 28-day signup → activated → paid funnel with top
  signup sources, from `server/utils/fleet-funnel.ts`): `Authorization: Bearer …`, 404 when the token is unset, 401
  on a bad one (`requireFleetToken()`). `/api/health` stays public for dumb
  uptime checks. The feedback layer adds **`GET /api/fleet/feedback`** behind
  the same bearer: the one fleet route that returns rows (message, kind, page,
  replay link, sender name or address; never the IP hash or user agent), so the
  owner reads feedback in fleet without signing in to the app. Read-only;
  triage and replies stay in the app. Holding the fleet token therefore reads
  feedback text, so rotate it like a credential. All three are allowlisted in `server/middleware/auth.ts` because
  the session guard must not 401 them first. Never edit `collectFleetCounters()` to add a fork-specific counter, and don't add a second endpoint:
  register a contributor from a Nitro plugin (the app's, or a fork-owned layer's) in
  `server/utils/extensions.ts`. `registerFleetExtraContributor({ key, collect })` returns plain
  numbers that are merged into `extra`, which is the shape the dashboard already renders;
  `registerFleetCounterContributor()` adds a typed group beside `users` and `funnel`
  (feedback's, and billing's `entitlements: { byStatus }`). The funnel's `paid` stage is the one
  number core cannot count itself: billing registers it with `registerFunnelStageContributor({ key: 'paid', count })`,
  and with no contributor `funnel.paid` reads 0, so the funnel keeps its shape. With nothing
  registered the response carries only `users`, `opsEvents`, `funnel` and `extra` (`{}`).
- **`app-owned.json`** (template root) lists the template paths every app owns by
  design: brand, home page and layout, generated email and colour output, the
  schema composition root, the seed and the fork's own event and lifecycle
  registries. Syncs leave them alone and fleet's drift view excludes them. A
  fork's *other* deliberate differences from template-owned files go in its own
  `fleet.json` › `template.customized` (exact paths, or directory prefixes ending
  in `/`, which also declare template files the fork removed); everything else
  that differs is the convergence backlog fleet reports as `core_undeclared`.
- **The `product` block** in `fleet.json` names this product's north-star,
  activation and retention events, so the dashboard can chart any fork's
  funnel without knowing the product. Every name must be registered in
  `shared/utils/analytics-events.ts` (the template's) or `app-events.ts` (the
  fork's own, shipped empty) — `fleet:check` fails otherwise, and
  `captureServerEvent` only accepts registered names. `null` for an app with no
  users to grow.
- **Ops alerting.** Anything worth waking the owner up for calls
  `recordOpsEvent(db, { kind, detail, path })` — the error plugin already does
  for every 5xx — and `server/tasks/ops/alert.ts` drains the spool into one
  digest email every 30 minutes via the `[[send_email]] ALERT_EMAIL` binding.
  Unconfigured = one `ops_alert_unconfigured` log line per tick and nothing
  sent, but the retention sweep (`pruneOpsEvents()`) still runs, so the spool
  cannot grow without bound. Rows are marked notified only after the send resolves, so a mail
  hiccup retries instead of losing the alert. Always `await` the record call:
  a 5xx is exactly the path that ends the request before a floated promise runs.
- **Severity.** Every kind has a tier, from `server/utils/ops-severity.ts`: `critical` (the app
  stopped doing its job), `warning` (one part degraded, and the default for any kind nobody
  registered), or `info` (the system handled it). Core knows `server_error` only, escalated to
  critical at `SERVER_ERROR_CRITICAL_COUNT` in one digest. A layer or the app registers its own
  kinds with `registerOpsSeverity({ kind: { severity, action? } })` from a Nitro plugin, next to
  the `recordOpsEvent` call (billing registers `paddle_webhook_unconfigured`). The digest leads
  with the most severe kind, the subject starts `[Critical]`, `[Warning]` or `[Info]` so a mail
  filter can split them, critical kinds carry their "What to do" line, and a spool of only info
  rows waits up to `OPS_INFO_HOLD_MS` (a day) unless something louder goes out first.
  The `ops-triage` routine reads the same spool through `GET /api/ops/events`
  (bearer `NUXT_OPS_TOKEN`, 404 when unset). That route also reports the build sha
  and pending migrations, so the routine can tell when a merge never deployed.
