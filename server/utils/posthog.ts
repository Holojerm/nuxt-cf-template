// Server-side PostHog capture via plain fetch — no SDK, no node-compat
// surprises on Cloudflare Workers. Used for events fired from Nitro (auth
// callbacks, API errors, scheduled tasks) where we know more than the client
// does (auth method, server-side error stacks, etc.).
//
// Goes directly to `posthogHost` — no proxy needed since this runs on the
// Worker, not in a browser.

interface CaptureOpts {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
}

export async function captureServerEvent(opts: CaptureOpts): Promise<void> {
  const config = useRuntimeConfig()
  const key = config.public.posthogKey
  const host = (config.public.posthogHost as string) || 'https://us.i.posthog.com'
  if (!key) return

  try {
    const res = await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event: opts.event,
        distinct_id: opts.distinctId,
        properties: { ...opts.properties, $lib: 'posthog-server-fetch' },
        timestamp: new Date().toISOString(),
      }),
    })
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          kind: 'posthog_capture_failed',
          status: res.status,
          event: opts.event,
        }),
      )
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        kind: 'posthog_capture_error',
        event: opts.event,
        error: String(err),
      }),
    )
  }
}
