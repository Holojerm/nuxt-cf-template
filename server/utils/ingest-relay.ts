// The /ingest relay's settings (server/routes/ingest/[...path].ts): its rate-limit
// budget and whether PostHog is told the visitor's address.
//
// `/ingest/**` is an open, unauthenticated proxy to PostHog: anyone can point
// anything through it, and the PostHog project bills and retains whatever
// arrives. It is also the one surface where a *legitimate* browser is chatty
// (batched events, the SDK bundle, `/decide`), so the default is generous and
// the window long: 300 requests per 120s per address, which no single browser
// reaches and no spammer wants.
//
// ── Why 120s ─────────────────────────────────────────────────────────────────
// The window is deliberately not 10 or 60. Those are the only periods the native
// Rate Limiting binding accepts, so a 120s window can only ever be served by the
// KV backend (see `chooseBackendAmong` in rate-limit.ts). That is the right
// backend here: this traffic arrives from wherever the visitor is, and a per-colo
// count would make the effective budget depend on how spread out the abuse is.
// Keep a retuned window off 10 and 60 for the same reason.
//
// ── Changing it ──────────────────────────────────────────────────────────────
// A fork that needs other numbers calls `configureIngestRelay()` from a Nitro
// plugin instead of editing the route. Nothing to configure means the default.

export interface IngestRelayOptions {
  /** Requests allowed per window, per address. Default 300. */
  limit?: number
  /** Window length in seconds. Default 120; keep it off 10 and 60. */
  windowSeconds?: number
  /**
   * Send PostHog the visitor's address (as `x-forwarded-for`) so it can GeoIP
   * events. Default true. An app that deliberately collects no location sets
   * false and PostHog sees only the Worker's own address.
   */
  forwardClientIp?: boolean
}

export interface IngestLimiter {
  name: string
  limit: number
  windowSeconds: number
}

const DEFAULT_INGEST_LIMITER: IngestLimiter = { name: 'ingest', limit: 300, windowSeconds: 120 }

let ingestLimiter: IngestLimiter = DEFAULT_INGEST_LIMITER
let forwardClientIp = true

/** The budget `rateLimit()` is called with for every /ingest request. */
export function getIngestLimiter(): IngestLimiter {
  return ingestLimiter
}

/** Whether the relay tells PostHog the visitor's address. */
export function getForwardClientIp(): boolean {
  return forwardClientIp
}

/** Override the defaults. Omitted fields keep their default. */
export function configureIngestRelay(options: IngestRelayOptions): void {
  const limit = options.limit ?? DEFAULT_INGEST_LIMITER.limit
  const windowSeconds = options.windowSeconds ?? DEFAULT_INGEST_LIMITER.windowSeconds
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`configureIngestRelay: limit must be a positive integer, got ${limit}`)
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(
      `configureIngestRelay: windowSeconds must be a positive integer, got ${windowSeconds}`,
    )
  }
  ingestLimiter = { name: DEFAULT_INGEST_LIMITER.name, limit, windowSeconds }
  forwardClientIp = options.forwardClientIp ?? true
}

/** Test-only: back to the defaults. */
export function resetIngestRelayForTest(): void {
  ingestLimiter = DEFAULT_INGEST_LIMITER
  forwardClientIp = true
}
