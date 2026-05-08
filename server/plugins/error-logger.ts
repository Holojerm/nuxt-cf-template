// Structured error logging for unhandled API errors.
//
// Two destinations:
//   1. console.error JSON → Cloudflare Logs (cheap, queryable, always on)
//   2. PostHog `$exception` event → PostHog Errors UI (grouped, with stack
//      traces and the user's session attached). No-ops when posthogKey is
//      empty (template default), so this is safe to leave wired up.
//
// 4xx are skipped — they're expected user mistakes (401 unauthenticated, etc.)
// and would drown out real bugs.

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
        path: event?.path,
        method: event?.method,
      }),
    )

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
        path: event?.path,
        method: event?.method,
        status,
      },
    })
  })
})
