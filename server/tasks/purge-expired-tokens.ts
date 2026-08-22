// The template's one scheduled task, and the worked example for adding more.
//
// ── How this actually runs ───────────────────────────────────────────────────
// Nitro's `cloudflare_module` preset already exports a `scheduled()` handler
// (nitropack/dist/presets/cloudflare/runtime/_module-handler.mjs). When
// `nitro.experimental.tasks` is true it calls `runCronTasks(controller.cron)`,
// which looks up `nitro.scheduledTasks` for the cron expression Cloudflare
// fired and runs the task names mapped to it. So wiring a cron job is exactly
// two edits and no custom Worker entry:
//
//   1. `nitro.scheduledTasks` in nuxt.config.ts — cron expression → task name
//   2. `[triggers] crons` in wrangler.toml    — the same expression
//
// Those two lists must agree. The lookup is an exact STRING match on the cron
// expression, so `"0 4 * * *"` and `"0 04 * * *"` are different keys: Cloudflare
// fires, Nitro finds no tasks for that string, and the handler returns success
// having done nothing. There is no error and no log line. If a task silently
// never runs, compare those two strings first.
//
// ── In `bun dev` ─────────────────────────────────────────────────────────────
// Yes, it runs. The dev server is a different preset (`_nitro/runtime/
// nitro-dev.mjs`), which calls `startScheduleRunner()` when tasks are enabled
// and drives the same `scheduledTasks` map with croner, in-process. So leaving
// `bun dev` open overnight really does purge your local D1 at 04:00.
//
// It is NOT on the wrangler path — `bun dev` is `nuxt dev`, not `wrangler dev`,
// so the `/cdn-cgi/handler/scheduled` test route Cloudflare's docs describe does
// not exist here. Nitro's own equivalent does: the dev server mounts
// `/_nitro/tasks/:name`, so
//
//     curl https://my-app.localhost/_nitro/tasks/purge-expired-tokens
//
// runs this immediately, and `?graceSeconds=0` makes it delete rows that only
// just died. That route is dev-only and is not in a production build.
//
// Scheduled tasks are also skipped entirely under vitest (`isTest` in Nitro's
// task runtime), which is why the DB logic lives in server/utils/purge.ts and
// is tested there rather than through this wrapper.

import { z } from 'zod'

import { purgeExpiredTokens, PURGE_BATCH_LIMIT, PURGE_GRACE_SECONDS } from '../utils/purge'

// Cron delivers `{ scheduledTime }` and nothing else, so in practice this
// validates the hand-run dev route above — where the values arrive as query
// strings typed by a person. `coerce` because `?graceSeconds=0` is the string
// "0", and the default branch is what the cron itself takes.
const PayloadSchema = z.object({
  graceSeconds: z.coerce.number().int().min(0).max(31_536_000).default(PURGE_GRACE_SECONDS),
  limit: z.coerce.number().int().min(1).max(50_000).default(PURGE_BATCH_LIMIT),
})

export default defineTask({
  meta: {
    name: 'purge-expired-tokens',
    description: 'Delete spent and expired magic-link tokens and MCP connect codes',
  },
  async run({ payload }) {
    // Never throw out of here on bad input: a cron task that errors is retried
    // on Cloudflare's schedule with the same bad payload. Fall back to the
    // defaults and say so.
    const parsed = PayloadSchema.safeParse(payload ?? {})
    if (!parsed.success) {
      console.warn(
        JSON.stringify({ kind: 'purge_payload_invalid', issues: parsed.error.issues.length }),
      )
    }
    const options = parsed.success ? parsed.data : PayloadSchema.parse({})

    const started = Date.now()
    // `db` is the NuxtHub auto-import. It resolves the D1 binding lazily off
    // `globalThis.__env__`, which the preset's `scheduled()` sets before it
    // calls us — so there is a real database here even though no request ran.
    const result = await purgeExpiredTokens(db, options)

    console.info(
      JSON.stringify({
        kind: 'purge_expired_tokens',
        ...result,
        durationMs: Date.now() - started,
      }),
    )

    return { result }
  },
})
