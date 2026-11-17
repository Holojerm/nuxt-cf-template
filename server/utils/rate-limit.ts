// Rate limiting. One strict counter in D1, with Cloudflare's native limiter
// in front of it as a free first check.
//
// Both are abuse control, not metering. For a quota anything is billed on, use
// a Durable Object.
//
// The count: one row per caller, endpoint and window in `rate_limits`, moved by
// a single `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING
// count`. D1 runs writes one at a time, so the number that comes back is exact
// however many requests arrive together, and it is the same count in every
// Cloudflare location. The window is fixed, not sliding (`limit` at the end of
// one window plus `limit` at the start of the next). A blocked request still
// counts. The row's key is a hash, so no address is kept.
//
// The first check: Cloudflare's Rate Limiting binding (`[[ratelimits]]` in
// wrangler.toml). It is NOT trusted to let anything through, only to refuse:
//   * It counts on the machine that happens to serve the request and shares
//     that count "in the background". Measured on production in November 2026:
//     120 requests on one kept-alive connection were stopped after 31, and 200
//     requests on a fresh connection each were never stopped at all.
//   * It counts per Cloudflare location, and answers `{ success }` only.
//   * Its (limit, period) is FIXED AT DEPLOY and `limit()` takes only a key, so
//     only a call site whose numbers equal a registered spec uses it.
// What it is good for is refusing a flood on one connection before that flood
// costs a D1 write each.
//
// This used to be "native where the numbers match, otherwise a counter in KV".
// Both let a determined client through: the native one for the reason above,
// and KV because read-then-write is not atomic (75 simultaneous requests were
// counted as 10).

// Explicit, not NuxtHub's auto-import: that resolves for TypeScript but is not
// injected here at runtime, and the resulting `db is not defined` would be
// swallowed by the fail-open path (see gotchas.md).
import { db } from '@nuxthub/db'
import * as tables from '@nuxthub/db/schema'
import { lt, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { clientIp, sha256Hex } from './hash'
import { pathForLog, logEvent } from './log'

/** Where hits are counted. `hit` must be atomic: it is the whole of the guarantee. */
export interface RateLimitStore {
  /** Counts one hit in `bucket` and returns the count including it. */
  hit(bucket: string, expiresAt: Date): Promise<number>
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
 * Counts one hit against a window and reports the verdict. Takes the store and
 * the clock explicitly so test/rate-limit.test.ts can drive it directly.
 */
export async function consumeRateLimit(
  store: RateLimitStore,
  { key, limit, windowSeconds }: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(now / 1000 / windowSeconds)
  const resetSeconds = (window + 1) * windowSeconds - Math.floor(now / 1000)
  // Hashed: the key holds an address or a mailbox, and the row outlives the
  // request until the daily purge.
  const bucket = await sha256Hex(`ratelimit:${key}:${window}`)
  const count = await store.hit(bucket, new Date((window + 1) * windowSeconds * 1000))
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds }
}

type RateLimitDb = Pick<typeof db, 'insert' | 'delete'>

/** The counter in D1: one statement, so two requests can never read the same count. */
export function d1RateLimitStore(database: RateLimitDb): RateLimitStore {
  const { rateLimits } = tables
  return {
    async hit(bucket, expiresAt) {
      const [row] = await database
        .insert(rateLimits)
        .values({ bucket, count: 1, expiresAt })
        .onConflictDoUpdate({
          target: rateLimits.bucket,
          set: { count: sql`${rateLimits.count} + 1` },
        })
        .returning({ count: rateLimits.count })
      return row?.count ?? 1
    },
  }
}

/** Removes counters whose window is over. Run by the daily purge; returns how many went. */
export async function pruneRateLimits(database: RateLimitDb, now: Date = new Date()) {
  const pruned = await database
    .delete(tables.rateLimits)
    .where(lt(tables.rateLimits.expiresAt, now))
    .returning({ bucket: tables.rateLimits.bucket })
  return pruned.length
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
// registered spec gets that binding as its first check; anything else gets
// none. Keyed by binding, so
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
 * The unsubscribe surface's budget. Deliberately NOT NATIVE_LIMITER's numbers,
 * so the native first check never sees it: its realistic caller is a mail
 * provider fanning out across many locations, and a retune of the auth budget
 * should not move it.
 */
export const UNSUBSCRIBE_LIMITER = { name: 'email-unsubscribe', limit: 60, windowSeconds: 120 }

/** Resolved native bindings, by binding name. */
export type NativeLimiters = Readonly<Record<string, NativeRateLimiter>>

/**
 * The native limiter that may give this call site its first check: one whose
 * numbers equal the call site's on BOTH counts, and whose binding this Worker
 * has. A binding configured 30/60s cannot be asked for 20/60s, so anything
 * else gets none and goes straight to the count.
 */
export function nativeFor(
  natives: NativeLimiters | undefined,
  opts: Pick<RateLimitOptions, 'limit' | 'windowSeconds'>,
): NativeRateLimiter | undefined {
  if (!natives) return undefined
  const match = getNativeLimiters().find(
    (spec) => spec.windowSeconds === opts.windowSeconds && spec.limit === opts.limit,
  )
  return match ? natives[match.binding] : undefined
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

/** What actually happened. */
export interface RateLimitVerdict {
  allowed: boolean
  /**
   * What decided. `native` only ever refuses; `d1` is the count; `unavailable`
   * means the count threw and the request was let through.
   */
  backend: 'native' | 'd1' | 'unavailable'
  /** Requests left in this window, or null when the count could not be read. */
  remaining: number | null
  /** Seconds until the caller may retry. An upper bound when `native` refused. */
  resetSeconds: number
  /** Set only when `backend` is `unavailable`. */
  error?: string
}

/**
 * Spend one request: the native first check when the call site has one, then
 * the count.
 *
 * Fails OPEN, here rather than in the H3 wrapper, so it is a tested property:
 * an outage in abuse control must not take the product down. A native binding
 * that throws is ignored, since the count still decides.
 */
export async function checkRateLimit(
  backends: { natives?: NativeLimiters; store: RateLimitStore },
  opts: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  const native = nativeFor(backends.natives, opts)
  if (native) {
    const refused = await native
      .limit({ key: opts.key })
      .then(({ success }) => !success)
      .catch(() => false)
    // No count and no reset clock from the binding; one full period is always
    // enough to wait.
    if (refused) {
      return { allowed: false, backend: 'native', remaining: 0, resetSeconds: opts.windowSeconds }
    }
  }
  try {
    return { ...(await consumeRateLimit(backends.store, opts, now)), backend: 'd1' }
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

/**
 * H3 wrapper: rate-limit this request by IP, or throw 429.
 *
 *   await rateLimit(event, { name: 'login', limit: 10, windowSeconds: 60 })
 *
 * Fails OPEN: the failure is logged as `rate_limit_unavailable`.
 * `X-RateLimit-Limit` and, when blocked, `Retry-After` go out on every path;
 * `X-RateLimit-Remaining` whenever the count was read.
 */
export async function rateLimit(
  event: H3Event,
  opts: { name: string; limit: number; windowSeconds: number; identifier?: string },
): Promise<void> {
  const identifier = opts.identifier ?? getClientIp(event)

  const verdict = await checkRateLimit(
    { natives: resolveNativeLimiters(event), store: d1RateLimitStore(db) },
    {
      key: `${opts.name}:${identifier}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds,
    },
  )

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
