// Structured error logging for unhandled API errors.
//
// Three destinations:
//   1. console.error JSON → Cloudflare Logs (cheap, queryable, always on)
//   2. the `ops_events` spool → server/tasks/ops/alert.ts emails a digest on
//      a cron. This is the one that reaches someone who isn't looking at a
//      dashboard, which is the whole point. Awaited, because Workers cancels
//      in-flight promises once the response is sent and a 5xx is exactly the
//      path that sends one immediately.
//   3. PostHog `$exception` event → PostHog Errors UI (grouped, with stack
//      traces and the user's session attached). No-ops when posthogKey is
//      empty (template default), so this is safe to leave wired up.
//
// 4xx are skipped — they're expected user mistakes (401 unauthenticated, etc.)
// and would drown out real bugs.

// Explicit, not the Nitro auto-import that every sibling also spells out. This
// file is the one that runs while a 500 is already in flight, so a symbol that
// resolves to `undefined` at runtime — the failure CLAUDE.md › Gotchas
// documents — would throw inside the error handler and take the log line with
// the exception it was trying to record.
import { db } from '@nuxthub/db'

import { pathForLog } from '../utils/log'
import { recordOpsEvent } from '../utils/ops'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('error', async (error, { event }) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status < 500) return

    const err = error as Error
    console.error(
      JSON.stringify({
        kind: 'server_error',
        status,
        message: err.message,
        stack: err.stack,
        // Never event.path — the unsubscribe and magic-link routes carry a live
        // credential in their query string, and a 5xx is precisely when it is
        // still unspent. See server/utils/log.ts.
        path: pathForLog(event?.path),
        method: event?.method,
      }),
    )

    await recordOpsEvent(db, {
      kind: 'server_error',
      detail: `${status} ${err.message}`,
      path: pathForLog(event?.path),
    })

    let distinctId = 'server-anonymous'
    if (event) {
      try {
        const session = await getUserSession(event)
        if (session?.user && 'id' in session.user && session.user.id != null) {
          distinctId = String(session.user.id)
        }
      } catch {
        // session lookup can fail on malformed requests; fall through
      }
    }

    void captureServerEvent({
      distinctId,
      event: '$exception',
      properties: {
        $exception_list: [
          {
            type: err.name || 'Error',
            value: err.message,
            mechanism: { handled: false, type: 'generic' },
            stacktrace: err.stack ? { type: 'raw', frames: [{ raw: err.stack }] } : undefined,
          },
        ],
        $exception_message: err.message,
        $exception_type: err.name || 'Error',
        // Never event.path — the unsubscribe and magic-link routes carry a live
        // credential in their query string, and a 5xx is precisely when it is
        // still unspent. See server/utils/log.ts.
        path: pathForLog(event?.path),
        method: event?.method,
        status,
      },
    })
  })
})
