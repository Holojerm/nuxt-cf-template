// Rate limiting for unauthenticated endpoints, backed by Cloudflare KV.
//
// ── What this is, honestly ───────────────────────────────────────────────────
// A fixed-window counter in an eventually-consistent store. It is abuse control
// — it stops a script hammering /api/auth/dev or minting a thousand connect
// codes — not a metering primitive. KV reads can serve a stale count and KV
// caps sustained writes to roughly one per second per key, so a determined
// attacker spraying from many colos can overshoot the limit for a beat.
//
// If you need an exact quota (per-seat API credits, anything you bill on), move
// that counter to a Durable Object, which is strongly consistent and single
// threaded. Leave this here for the front door.
//
// The window is fixed, not sliding: a caller can spend `limit` at the end of one
// window and `limit` again at the start of the next. That's the standard
// trade-off for one KV read + one write per request, and it's the right one for
// a login endpoint.

// `kv` is imported explicitly rather than relying on NuxtHub's auto-import.
// The auto-import resolves for TypeScript but is not injected into this file at
// runtime, so the limiter silently fell into its fail-open path on every request
// with `ReferenceError: kv is not defined` — visible only in the logs, since
// failing open is the whole design. An explicit import can't do that quietly.
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'

/** The slice of unstorage's Storage we use — lets tests pass a Map-backed fake. */
export interface RateLimitStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<unknown>
}

export interface RateLimitOptions {
  /** Identifies the caller + endpoint, e.g. `login:203.0.113.4`. */
  key: string
  /** Requests allowed per window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Requests left in this window (0 when blocked). */
  remaining: number
  /** Seconds until the window rolls over — the Retry-After value. */
  resetSeconds: number
}

/**
 * Pure-ish limiter: counts one hit against a window and reports the verdict.
 * Takes the store explicitly so test/rate-limit.test.ts can drive it directly.
 */
export async function consumeRateLimit(
  store: RateLimitStore,
  { key, limit, windowSeconds }: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(now / 1000 / windowSeconds)
  const storeKey = `ratelimit:${key}:${window}`
  const resetSeconds = (window + 1) * windowSeconds - Math.floor(now / 1000)

  const raw = await store.get(storeKey)
  // unstorage round-trips JSON, but a KV value written by an older deploy (or a
  // hand-run wrangler command) can come back as a string. Coerce rather than NaN.
  const count = typeof raw === 'number' ? raw : Number(raw ?? 0) || 0

  if (count >= limit) {
    return { allowed: false, remaining: 0, resetSeconds }
  }

  // TTL is the remaining window plus a second of slack, so keys expire on their
  // own and the namespace never accumulates dead counters.
  await store.set(storeKey, count + 1, { ttl: resetSeconds + 1 })
  return { allowed: true, remaining: limit - count - 1, resetSeconds }
}

/**
 * The caller's IP as Cloudflare sees it.
 *
 * `cf-connecting-ip` is set by the edge and cannot be spoofed by the client;
 * x-forwarded-for can be, so it's only a local-dev fallback. Unknown callers
 * share one bucket — deliberately, so a header-stripping proxy fails closed
 * into a shared limit rather than open into no limit at all.
 */
export function getClientIp(event: H3Event): string {
  return (
    getRequestHeader(event, 'cf-connecting-ip') ??
    getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

/**
 * H3 wrapper: rate-limit this request by IP, or throw 429.
 *
 *   await rateLimit(event, { name: 'login', limit: 10, windowSeconds: 60 })
 *
 * Fails OPEN. If KV is unreachable the request is allowed through — an outage in
 * the abuse-control layer must not take the product down with it. The failure is
 * logged so it shows up in Cloudflare Logs instead of passing silently.
 */
export async function rateLimit(
  event: H3Event,
  opts: { name: string; limit: number; windowSeconds: number; identifier?: string },
): Promise<void> {
  const identifier = opts.identifier ?? getClientIp(event)

  let result: RateLimitResult
  try {
    result = await consumeRateLimit(kv, {
      key: `${opts.name}:${identifier}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds,
    })
  } catch (error) {
    console.warn(
      JSON.stringify({ kind: 'rate_limit_unavailable', name: opts.name, error: String(error) }),
    )
    return
  }

  setResponseHeader(event, 'X-RateLimit-Limit', String(opts.limit))
  setResponseHeader(event, 'X-RateLimit-Remaining', String(result.remaining))

  if (!result.allowed) {
    // h3 types Retry-After as a number (it's delta-seconds, per RFC 9110).
    setResponseHeader(event, 'Retry-After', result.resetSeconds)
    console.warn(JSON.stringify({ kind: 'rate_limited', name: opts.name, path: event.path }))
    throw createError({
      statusCode: 429,
      message: 'Too many requests',
      data: { code: 'rate_limited', retryAfter: result.resetSeconds },
    })
  }
}
