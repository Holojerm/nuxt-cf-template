// Rate limiting for unauthenticated endpoints. Two backends, one front door.
//
// Both are abuse control, not metering. For an exact quota (anything billed),
// use a Durable Object.
//
// Backend 1: Cloudflare's native Rate Limiting binding (preferred). Declared as
// `[[ratelimits]]` in wrangler.toml; runs in the runtime, so it is faster and
// cannot be raced by a slow KV write. Caveats:
//   * It counts PER COLO: "30 per minute" is 30 in each location. Accepted: the
//     realistic attacker on a login form is one host in one place.
//   * Cloudflare calls it permissive and eventually consistent.
//   * It answers `{ success }` only: no count, no reset time (see `rateLimit`).
//   * Its (limit, period) is FIXED AT DEPLOY and `limit()` takes only a key, so
//     `chooseBackendAmong` refuses to delegate a call site whose numbers differ:
//     asking for 20/60s and silently getting 30/60s fails nowhere visible.
//
// Backend 2: a fixed-window counter in KV (fallback). KV can serve a stale count
// and caps sustained writes to ~1/s per key, so a spray from many colos can
// overshoot for a beat. The window is fixed, not sliding (`limit` at the end of
// one window plus `limit` at the start of the next); right for a login endpoint
// at one read and one write per request. KV is the only backend for any window
// the binding is not configured for (300s connect code, 600s export) and where
// no Worker env is bound.

// Explicit, not NuxtHub's auto-import: that resolves for TypeScript but is not
// injected here at runtime, and the resulting `kv is not defined` would be
// swallowed by the fail-open path (see gotchas.md).
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'
import { clientIp } from './hash'
import { pathForLog, logEvent } from './log'

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
  // A value written by another runtime can come back as a string; coerce, or
  // NaN >= limit is false and the limit is silently off.
  const count = typeof raw === 'number' ? raw : Number(raw ?? 0) || 0

  if (count >= limit) {
    return { allowed: false, remaining: 0, resetSeconds }
  }

  // Remaining window plus a second of slack, so dead counters expire.
  await store.set(storeKey, count + 1, { ttl: resetSeconds + 1 })
  return { allowed: true, remaining: limit - count - 1, resetSeconds }
}

/** The slice of Cloudflare's `RateLimit` binding we use — lets tests fake it. */
export interface NativeRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * What `[[ratelimits]]` in wrangler.toml declares. These numbers MUST match that
 * block; `test/rate-limit.test.ts` probes the real binding, because a mismatch
 * does not throw, it just stops anything using the native path. `windowSeconds`
 * is `10 | 60` because the platform accepts nothing else.
 */
export interface NativeLimiterSpec {
  /** Binding name — must match `name` in the wrangler.toml block. */
  binding: string
  limit: number
  windowSeconds: 10 | 60
}

export const NATIVE_LIMITER: NativeLimiterSpec = {
  binding: 'RATE_LIMITER',
  limit: 30,
  windowSeconds: 60,
}

// More native budgets: a second `[[ratelimits]]` block (own name and
// namespace_id) plus `registerNativeLimiter({ binding, limit, windowSeconds })`
// from a Nitro plugin, never an edit here. A `rateLimit()` whose numbers equal a
// registered spec goes native; anything else stays on KV. Keyed by binding, so
// re-registering replaces.
const nativeLimiters = new Map<string, NativeLimiterSpec>([
  [NATIVE_LIMITER.binding, NATIVE_LIMITER],
])

export function registerNativeLimiter(spec: NativeLimiterSpec): void {
  if (spec.binding === NATIVE_LIMITER.binding) {
    throw new Error(`registerNativeLimiter: ${spec.binding} is core's own limiter`)
  }
  for (const other of nativeLimiters.values()) {
    if (
      other.binding !== spec.binding &&
      other.limit === spec.limit &&
      other.windowSeconds === spec.windowSeconds
    ) {
      // Two bindings with one budget: which serves a call site would be a coin toss.
      throw new Error(
        `registerNativeLimiter: ${spec.binding} duplicates ${other.binding} ` +
          `(${spec.limit}/${spec.windowSeconds}s)`,
      )
    }
  }
  nativeLimiters.set(spec.binding, spec)
}

export function getNativeLimiters(): NativeLimiterSpec[] {
  return [...nativeLimiters.values()]
}

/** Test-only: drop every registered limiter, leaving core's. */
export function clearNativeLimitersForTest(): void {
  nativeLimiters.clear()
  nativeLimiters.set(NATIVE_LIMITER.binding, NATIVE_LIMITER)
}

/**
 * The unsubscribe surface's budget. Deliberately NOT NATIVE_LIMITER's numbers:
 * 30/60 matched the binding exactly, which silently put this surface on the
 * per-colo native limiter (its realistic caller is a mail provider fanning out
 * across many colos) and tied it to any retune of the auth budget. 60/120s keeps
 * the rate but is unmatchable (120 is not 10 or 60), so it stays on KV, counted
 * globally.
 */
export const UNSUBSCRIBE_LIMITER = { name: 'email-unsubscribe', limit: 60, windowSeconds: 120 }

/** Why a call site fell back to KV. Reported once per call site, per isolate. */
export type KvFallbackReason = 'binding-absent' | 'window-mismatch' | 'limit-mismatch'

export type BackendChoice =
  | { backend: 'native'; native: NativeRateLimiter }
  | { backend: 'kv'; reason: KvFallbackReason }

/** Resolved native bindings, by binding name. */
export type NativeLimiters = Readonly<Record<string, NativeRateLimiter>>

/**
 * Which backend may serve this request: exact match on BOTH numbers, or KV. A
 * binding configured 30/60s cannot be asked for 20/60s, so routing a 20/60s
 * handler through it would enforce 30 while `X-RateLimit-Limit: 20` went out.
 * "Use it when the binding is stricter" has the same flaw reversed. To move a
 * call site onto a binding, give it a registered spec's numbers.
 *
 * `natives` are the bindings this Worker actually has, by name; a matching spec
 * whose binding is missing falls back to KV with `binding-absent`.
 */
export function chooseBackendAmong(
  natives: NativeLimiters | undefined,
  opts: Pick<RateLimitOptions, 'limit' | 'windowSeconds'>,
): BackendChoice {
  if (!natives || Object.keys(natives).length === 0) {
    return { backend: 'kv', reason: 'binding-absent' }
  }
  const specs = getNativeLimiters()
  const match = specs.find((s) => s.windowSeconds === opts.windowSeconds && s.limit === opts.limit)
  if (match) {
    const native = natives[match.binding]
    return native ? { backend: 'native', native } : { backend: 'kv', reason: 'binding-absent' }
  }
  const sameWindow = specs.some((s) => s.windowSeconds === opts.windowSeconds)
  return { backend: 'kv', reason: sameWindow ? 'limit-mismatch' : 'window-mismatch' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The registered bindings found on the Worker env. Nitro puts `env` on
 * `event.context.cloudflare` (production and `nuxt dev` via getPlatformProxy),
 * but `event.context` is `any`, so only the `typeof limit === 'function'` check
 * proves a binding is there. A trimmed wrangler.toml or non-Cloudflare preset
 * gets KV instead of a TypeError.
 */
export function resolveNativeLimiters(event: H3Event): NativeLimiters | undefined {
  const cloudflare: unknown = event.context.cloudflare
  if (!isRecord(cloudflare) || !isRecord(cloudflare.env)) return undefined

  const found: Record<string, NativeRateLimiter> = {}
  for (const { binding: name } of getNativeLimiters()) {
    const binding = cloudflare.env[name]
    if (isRecord(binding) && typeof binding.limit === 'function') {
      found[name] = binding as unknown as NativeRateLimiter
    }
  }
  return Object.keys(found).length > 0 ? found : undefined
}

/** What actually happened, once a backend has been picked and run. */
export interface RateLimitVerdict {
  allowed: boolean
  /** `unavailable` means the backend threw and the request was let through. */
  backend: 'native' | 'kv' | 'unavailable'
  /** Requests left in this window, or null when the backend cannot say. */
  remaining: number | null
  /** Seconds until the caller may retry. An upper bound on the native path. */
  resetSeconds: number
  /** Why the KV path was chosen — for the one-line-per-call-site log. */
  reason?: KvFallbackReason
  /** Set only when `backend` is `unavailable`. */
  error?: string
}

/**
 * Pick a backend, spend one request against it, and normalise the answer.
 *
 * Fails OPEN, here rather than in the H3 wrapper, so it is a tested property.
 * A throwing native binding does NOT cascade to KV: that would charge a request
 * both backends' latency exactly when the platform is unhealthy, and hide the
 * broken binding. Broken limiter: request goes through, log says so.
 */
export async function consumeRateLimitWithFallback(
  backends: { natives?: NativeLimiters; store: RateLimitStore },
  opts: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  const choice = chooseBackendAmong(backends.natives, opts)

  try {
    if (choice.backend === 'native') {
      const { success } = await choice.native.limit({ key: opts.key })
      return {
        allowed: success,
        backend: 'native',
        // Blocked means 0 left; allowed means unknown (the binding returns a
        // boolean), and null beats an invented number.
        remaining: success ? null : 0,
        // No reset clock either; one full period is always enough to wait.
        resetSeconds: opts.windowSeconds,
      }
    }

    const result = await consumeRateLimit(backends.store, opts, now)
    return { ...result, backend: 'kv', reason: choice.reason }
  } catch (error) {
    return {
      allowed: true,
      backend: 'unavailable',
      remaining: null,
      resetSeconds: 0,
      error: String(error),
    }
  }
}

/**
 * The rate-limit bucket for a caller with no `identifier`: their IP, or one
 * shared `unknown` bucket so a header-stripping proxy fails closed into a
 * shared limit rather than open into none.
 */
export function getClientIp(event: H3Event): string {
  return clientIp(event) ?? 'unknown'
}

/** Backends already reported, so the line is emitted once per call site per isolate. */
const reportedBackends = new Set<string>()

/**
 * Say once per endpoint which limiter guards it, with the fallback reason. A
 * limiter that quietly is not the one you think (`kv` undefined once left every
 * request on the fail-open path) is otherwise invisible.
 */
function reportBackend(name: string, verdict: RateLimitVerdict): void {
  if (verdict.backend === 'unavailable' || reportedBackends.has(name)) return
  reportedBackends.add(name)
  logEvent('info', 'rate_limit_backend', {
    name,
    backend: verdict.backend,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  })
}

/**
 * H3 wrapper: rate-limit this request by IP, or throw 429.
 *
 *   await rateLimit(event, { name: 'login', limit: 10, windowSeconds: 60 })
 *
 * Fails OPEN: an outage in abuse control must not take the product down; the
 * failure is logged. `X-RateLimit-Limit` and `Retry-After` go out on both
 * paths; `X-RateLimit-Remaining` only when known (always on KV, on native only
 * when blocked), so a bare `Limit` means the native limiter served it.
 */
export async function rateLimit(
  event: H3Event,
  opts: { name: string; limit: number; windowSeconds: number; identifier?: string },
): Promise<void> {
  const identifier = opts.identifier ?? getClientIp(event)

  const verdict = await consumeRateLimitWithFallback(
    { natives: resolveNativeLimiters(event), store: kv },
    {
      key: `${opts.name}:${identifier}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds,
    },
  )

  reportBackend(opts.name, verdict)

  if (verdict.backend === 'unavailable') {
    logEvent('warn', 'rate_limit_unavailable', { name: opts.name, error: verdict.error })
    return
  }

  setResponseHeader(event, 'X-RateLimit-Limit', String(opts.limit))
  if (verdict.remaining !== null) {
    setResponseHeader(event, 'X-RateLimit-Remaining', String(verdict.remaining))
  }

  if (!verdict.allowed) {
    // h3 types Retry-After as a number (it's delta-seconds, per RFC 9110).
    setResponseHeader(event, 'Retry-After', verdict.resetSeconds)
    logEvent('warn', 'rate_limited', {
      name: opts.name,
      // Not event.path: /api/auth/** includes routes carrying a live sign-in
      // token (see server/utils/log.ts).
      path: pathForLog(event.path),
      backend: verdict.backend,
    })
    throw createError({
      statusCode: 429,
      message: 'Too many requests',
      data: { code: 'rate_limited', retryAfter: verdict.resetSeconds },
    })
  }
}
