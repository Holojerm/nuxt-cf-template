// Rate limiting for unauthenticated endpoints. Two backends, one front door.
//
// ── What this is, honestly ───────────────────────────────────────────────────
// Neither backend is a metering primitive. Both are abuse control — they stop a
// script hammering /api/auth/dev or minting a thousand connect codes. If you
// need an exact quota (per-seat API credits, anything you bill on), move that
// counter to a Durable Object, which is strongly consistent and single threaded.
// Leave this here for the front door.
//
// ── Backend 1: Cloudflare's native Rate Limiting binding (preferred) ─────────
// `env.RATE_LIMITER.limit({ key })` — GA since September 2025, declared as
// `[[ratelimits]]` in wrangler.toml. It runs in the runtime rather than over the
// network, so it is faster and cannot be raced by a slow KV write.
//
// Its honest caveats, which are different from KV's and not smaller:
//
//   * It counts PER COLO. "30 per minute" means 30 per minute *in each
//     Cloudflare location*, so a caller distributed across data centres gets a
//     multiple of the number you wrote. KV is at least nominally global. This is
//     the trade this file makes deliberately: the realistic attacker on a login
//     form is one host in one place, and against that the native limiter is
//     both stricter and faster. Against a botnet neither backend is the answer.
//   * Cloudflare documents it as "permissive, eventually consistent, and
//     intentionally designed to not be used as an accurate accounting system."
//   * It answers `{ success }` and nothing else — no count, no reset time. What
//     that costs us is spelled out at `rateLimit` below.
//   * Its (limit, period) is FIXED AT DEPLOY. `limit()` takes only a key, so one
//     binding enforces exactly one budget. That is why `chooseBackend` refuses
//     to delegate a call site whose numbers differ: the alternative is a handler
//     asking for 20/60s, silently getting 30/60s, and nothing anywhere saying so.
//
// ── Backend 2: a fixed-window counter in KV (fallback) ───────────────────────
// KV reads can serve a stale count and KV caps sustained writes to roughly one
// per second per key, so a determined attacker spraying from many colos can
// overshoot the limit for a beat.
//
// The window is fixed, not sliding: a caller can spend `limit` at the end of one
// window and `limit` again at the start of the next. That's the standard
// trade-off for one KV read + one write per request, and it's the right one for
// a login endpoint.
//
// KV is not vestigial. It is the only backend for any window the binding is not
// configured for (the 300s connect-code limit, the 600s export limit), and the
// only one that exists at all where no Worker env is bound.

// `kv` is imported explicitly rather than relying on NuxtHub's auto-import.
// The auto-import resolves for TypeScript but is not injected into this file at
// runtime, so the limiter silently fell into its fail-open path on every request
// with `ReferenceError: kv is not defined` — visible only in the logs, since
// failing open is the whole design. An explicit import can't do that quietly.
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'
import { pathForLog } from './log'

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

// ─── The native binding ──────────────────────────────────────────────────────

/** The slice of Cloudflare's `RateLimit` binding we use — lets tests fake it. */
export interface NativeRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * What `[[ratelimits]]` in wrangler.toml declares. These two numbers MUST match
 * that block — `test/rate-limit.test.ts` probes the real binding and fails if
 * they drift, because a mismatch does not throw, it just quietly stops anything
 * from using the native path.
 *
 * `windowSeconds` is typed `10 | 60` rather than `number` on purpose: those are
 * the only two periods the platform accepts. Wrangler rejects anything else at
 * deploy; this makes `bun typecheck` reject it first.
 */
export const NATIVE_LIMITER: {
  /** Binding name — must match `name` in the wrangler.toml block. */
  binding: string
  limit: number
  windowSeconds: 10 | 60
} = {
  binding: 'RATE_LIMITER',
  limit: 30,
  windowSeconds: 60,
}

/** Why a call site fell back to KV. Reported once per call site, per isolate. */
export type KvFallbackReason = 'binding-absent' | 'window-mismatch' | 'limit-mismatch'

export type BackendChoice =
  | { backend: 'native'; native: NativeRateLimiter }
  | { backend: 'kv'; reason: KvFallbackReason }

/**
 * Which backend may serve this request.
 *
 * The rule is exact-match on BOTH numbers, and the strictness is the point. A
 * binding configured 30/60s cannot be asked for 20/60s at call time, so routing
 * a 20/60s handler through it would enforce 30 — looser than the handler asked
 * for — while `X-RateLimit-Limit: 20` went out on the response. The tempting
 * relaxation ("use it whenever the binding is *stricter* than the request") has
 * the same flaw pointed the other way: /api/health would silently become 30/60s
 * with a header still claiming 60.
 *
 * So: match, or use KV. To move another call site onto the binding, give it the
 * same numbers as NATIVE_LIMITER, or add a second `[[ratelimits]]` block with
 * its own namespace_id and a second entry here.
 */
export function chooseBackend(
  native: NativeRateLimiter | undefined,
  opts: Pick<RateLimitOptions, 'limit' | 'windowSeconds'>,
): BackendChoice {
  if (!native) return { backend: 'kv', reason: 'binding-absent' }
  if (opts.windowSeconds !== NATIVE_LIMITER.windowSeconds) {
    return { backend: 'kv', reason: 'window-mismatch' }
  }
  if (opts.limit !== NATIVE_LIMITER.limit) return { backend: 'kv', reason: 'limit-mismatch' }
  return { backend: 'native', native }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Pull the binding off the Worker env, or undefined when there isn't one.
 *
 * Nitro's cloudflare preset puts the Worker's `env` on `event.context.cloudflare`
 * — in production via the module handler's `_platform` context, and under
 * `nuxt dev` via wrangler's `getPlatformProxy()`, which miniflare backs with a
 * real local implementation of this binding. So dev usually DOES have it.
 *
 * "Usually" is why this is a runtime feature-detect rather than a config flag.
 * `H3EventContext extends Record<string, any>`, so `event.context.cloudflare` is
 * `any` and typechecks whatever you write; the `typeof limit === 'function'`
 * check is the only thing that actually proves a binding is there. A fork on an
 * older wrangler, a non-Cloudflare preset, or a `wrangler.toml` someone trimmed
 * all land here and get KV instead of a TypeError.
 */
export function resolveNativeLimiter(event: H3Event): NativeRateLimiter | undefined {
  const cloudflare: unknown = event.context.cloudflare
  if (!isRecord(cloudflare) || !isRecord(cloudflare.env)) return undefined

  const binding = cloudflare.env[NATIVE_LIMITER.binding]
  if (!isRecord(binding) || typeof binding.limit !== 'function') return undefined
  return binding as unknown as NativeRateLimiter
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
 * Fails OPEN, and owns that policy rather than leaving it to the H3 wrapper, so
 * it is a tested property of this function instead of a detail of the caller.
 *
 * A throwing native binding does NOT cascade to KV. It would be defensible —
 * but it makes one request pay both backends' latency at exactly the moment the
 * platform is unhealthy, and it means a broken binding is invisible because
 * everything keeps working. One policy, both backends: if the limiter is
 * broken, the request goes through and the log says so.
 */
export async function consumeRateLimitWithFallback(
  backends: { native?: NativeRateLimiter; store: RateLimitStore },
  opts: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  const choice = chooseBackend(backends.native, opts)

  try {
    if (choice.backend === 'native') {
      const { success } = await choice.native.limit({ key: opts.key })
      return {
        allowed: success,
        backend: 'native',
        // Blocked means zero left — that much is true. Allowed means we do not
        // know: the binding returns a boolean and nothing else. Reporting null
        // (and omitting the header) beats inventing a plausible number.
        remaining: success ? null : 0,
        // The binding exposes no reset clock either. Its window is `period`
        // seconds long, so waiting that long is always enough — an upper bound,
        // which is the safe direction to be wrong in for a Retry-After.
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
 * Which backend each call site resolved to, so the line below is emitted once
 * per call site per isolate rather than once per request. Bounded by the number
 * of `rateLimit()` call sites, all of which pass a literal `name`.
 */
const reportedBackends = new Set<string>()

/**
 * Say once, per endpoint, which limiter is actually guarding it.
 *
 * This exists because of how the last failure in this file presented: `kv` was
 * undefined at runtime, the limiter fell into its fail-open path on every
 * request, and — since failing open is the design — the only symptom was that
 * the feature was silently off. A backend that quietly isn't the one you think
 * it is has exactly that shape, so it gets said out loud, with the reason
 * attached: `limit-mismatch` tells a fork owner precisely what to change.
 */
function reportBackend(name: string, verdict: RateLimitVerdict): void {
  if (verdict.backend === 'unavailable' || reportedBackends.has(name)) return
  reportedBackends.add(name)
  console.info(
    JSON.stringify({
      kind: 'rate_limit_backend',
      name,
      backend: verdict.backend,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    }),
  )
}

/**
 * H3 wrapper: rate-limit this request by IP, or throw 429.
 *
 *   await rateLimit(event, { name: 'login', limit: 10, windowSeconds: 60 })
 *
 * Fails OPEN. If the limiter is unreachable the request is allowed through — an
 * outage in the abuse-control layer must not take the product down with it. The
 * failure is logged so it shows up in Cloudflare Logs instead of passing silently.
 *
 * ── About the headers ────────────────────────────────────────────────────────
 * `X-RateLimit-Limit` and `Retry-After` are emitted on both paths. The native
 * binding cannot report a live count, so `X-RateLimit-Remaining` is sent only
 * when it is known: always on the KV path, and on the native path only when the
 * request was blocked (where 0 is a fact, not a guess). A client that sees
 * `Limit` with no `Remaining` is being served by the native limiter — which is
 * a truer thing to tell it than a fabricated number would be.
 */
export async function rateLimit(
  event: H3Event,
  opts: { name: string; limit: number; windowSeconds: number; identifier?: string },
): Promise<void> {
  const identifier = opts.identifier ?? getClientIp(event)

  const verdict = await consumeRateLimitWithFallback(
    { native: resolveNativeLimiter(event), store: kv },
    {
      key: `${opts.name}:${identifier}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds,
    },
  )

  reportBackend(opts.name, verdict)

  if (verdict.backend === 'unavailable') {
    console.warn(
      JSON.stringify({ kind: 'rate_limit_unavailable', name: opts.name, error: verdict.error }),
    )
    return
  }

  setResponseHeader(event, 'X-RateLimit-Limit', String(opts.limit))
  if (verdict.remaining !== null) {
    setResponseHeader(event, 'X-RateLimit-Remaining', String(verdict.remaining))
  }

  if (!verdict.allowed) {
    // h3 types Retry-After as a number (it's delta-seconds, per RFC 9110).
    setResponseHeader(event, 'Retry-After', verdict.resetSeconds)
    console.warn(
      JSON.stringify({
        kind: 'rate_limited',
        name: opts.name,
        // pathForLog, not event.path: this fires on /api/auth/**, which includes
        // the routes that carry a live sign-in token. A 429 there is precisely
        // the moment the credential is both logged and still unspent — see
        // server/utils/log.ts.
        path: pathForLog(event.path),
        backend: verdict.backend,
      }),
    )
    throw createError({
      statusCode: 429,
      message: 'Too many requests',
      data: { code: 'rate_limited', retryAfter: verdict.resetSeconds },
    })
  }
}
