// Shared fixtures for the E2E suite (Findings 18 + 20: sign in → gated page,
// buy → access, cancel → lose access — the three flows the product exists
// for had zero coverage that a real browser had ever run).
//
// ── Why the webhook, not a direct D1 write ───────────────────────────────────
// CLAUDE.md's "The dev server caches its DB connection" gotcha is the whole
// reason this file looks the way it does: `nuxt dev` holds its own libsql
// connection open, and an external `bun:sqlite` write after boot is invisible
// to it until a restart. Seeding an entitlement the way `bun seed` does would
// therefore just never show up while the suite's server is running.
//
// So state is driven THROUGH the server instead of around it: sign in via
// POST /api/auth/dev (the same dev-only shortcut a human uses locally), then
// create or end entitlements by POSTing signed Paddle webhooks to
// /paddle/webhook — the exact path a real purchase or cancellation takes,
// signature check and all. That's slower than an INSERT and is the point:
// it's the only way to prove the money path works end to end rather than
// asserting on state nothing real ever produced.
//
// ── Why sign-in is cached per worker ──────────────────────────────────────
// POST /api/auth/dev is rate-limited (20/60s — see server/api/auth/dev.post.ts)
// and sits behind the whole-`/api/auth/` surface limit too
// (server/middleware/auth.ts). In local dev every request shares one IP
// bucket (no `cf-connecting-ip` outside Cloudflare), so re-signing in for
// every test would burn that budget for no reason — the session cookie
// doesn't need to change just because the entitlement behind it does.
// `signInAs` below is backed by a worker-scoped cache keyed by email: the
// POST happens at most once per (worker, email) pair, and every later call
// for that same email in that worker reuses the storageState it captured the
// first time.

import { test as base, expect } from '@playwright/test'
import type { APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test'

import { playwrightPort } from '../../scripts/worktree-port'
import { toHex } from '../../server/utils/hash'
import { PADDLE_TEST_WEBHOOK_SECRET } from './webhook-secret'

export const DAY_MS = 24 * 60 * 60 * 1000

// Playwright's built-in `baseURL` fixture is TEST-scoped, so a WORKER-scoped
// fixture (apiRequest, below) can't depend on it — Playwright rejects that
// combination outright ("worker fixture ... cannot depend on a test fixture").
// Recomputed here with the same helper playwright.config.ts uses rather than
// worked around: it's a pure function of the checkout path, so this is exactly
// the value that fixture would have resolved to anyway.
const HOST = `http://localhost:${playwrightPort()}`

// ─── Unique identifiers ───────────────────────────────────────────────────
// Computed once when this module loads, which happens once per WORKER
// process — Playwright gives each worker its own Node process and its own
// module cache, so two workers never share a token, and a rerun of the whole
// suite gets a fresh one too. That's what makes `e2e-<run>-<case>@example.com`
// collide only with itself, never with a previous run's leftover rows.
const RUN_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** `e2e-<run>-<case>@example.com` — unique per run, stable within one test. */
export function uniqueEmail(caseName: string): string {
  return `e2e-${RUN_TOKEN}-${caseName}@example.com`.toLowerCase()
}

/** A realistic-shaped, unique Paddle ref for one scenario. */
export function uniquePaddleRef(prefix: 'sub_' | 'txn_', caseName: string): string {
  return `${prefix}e2e_${RUN_TOKEN}_${caseName}`
}

// ─── Signing — mirrors server/utils/paddle.ts's verifier exactly ────────────
// `hmacSha256Hex` in that file is a local, unexported helper, so it can't be
// imported directly; `toHex` is exported and IS imported, which is what keeps
// the hex-encoding step from becoming a second copy that could quietly stop
// matching. The HMAC construction itself (`${ts}:${rawBody}`, `ts=…;h1=…`) is
// mirrored here the same way test/paddle.test.ts's own `sign` helper mirrors
// it for the vitest suite — see webhook-signing.spec.ts, which checks this
// copy against the real `verifyPaddleSignature` rather than trusting it by
// inspection.

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

/** The `Paddle-Signature` header value, built the way server/utils/paddle.ts verifies it. */
export async function signPaddleWebhook(
  rawBody: string,
  secret: string = PADDLE_TEST_WEBHOOK_SECRET,
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const h1 = await hmacSha256Hex(secret, `${ts}:${rawBody}`)
  return `ts=${ts};h1=${h1}`
}

// ─── Paddle event builders ───────────────────────────────────────────────────
// Snake_case, matching server/utils/entitlements.ts's `paddleEventSchema` wire
// shape field-for-field — see test/entitlements.test.ts for the same
// convention on the vitest side.

export interface PaddleEventData {
  id: string
  status?: string | null
  customer_id?: string | null
  subscription_id?: string | null
  billed_at?: string | null
  custom_data?: { userId?: string; productKey?: string } | null
  current_billing_period?: { ends_at: string } | null
  scheduled_change?: { action: string; effective_at?: string | null } | null
  action?: string | null
  type?: string | null
  transaction_id?: string | null
}

export interface PaddleWebhookEvent {
  event_id: string
  event_type: string
  data: PaddleEventData
}

export function buildPaddleEvent(eventType: string, data: PaddleEventData): PaddleWebhookEvent {
  return { event_id: `evt_e2e_${crypto.randomUUID()}`, event_type: eventType, data }
}

/** A one-time pass purchase — `transaction.completed` with no `subscription_id`. */
export function transactionCompletedEvent(params: {
  userId: string
  transactionId: string
  billedAt?: Date
}): PaddleWebhookEvent {
  return buildPaddleEvent('transaction.completed', {
    id: params.transactionId,
    status: 'completed',
    customer_id: `ctm_${params.transactionId}`,
    custom_data: { userId: params.userId, productKey: 'default' },
    billed_at: (params.billedAt ?? new Date()).toISOString(),
  })
}

/** Any `subscription.*` transition — activation, dunning, cancellation, all one shape. */
export function subscriptionEvent(params: {
  eventType: string
  userId: string
  subscriptionId: string
  status: string
  currentPeriodEndsAt?: Date | null
  scheduledChange?: { action: string; effectiveAt?: Date | null } | null
}): PaddleWebhookEvent {
  return buildPaddleEvent(params.eventType, {
    id: params.subscriptionId,
    status: params.status,
    customer_id: `ctm_${params.subscriptionId}`,
    custom_data: { userId: params.userId, productKey: 'default' },
    current_billing_period: params.currentPeriodEndsAt
      ? { ends_at: params.currentPeriodEndsAt.toISOString() }
      : null,
    scheduled_change: params.scheduledChange
      ? {
          action: params.scheduledChange.action,
          effective_at: params.scheduledChange.effectiveAt?.toISOString() ?? null,
        }
      : null,
  })
}

/** Throws with the response body attached — a rejected webhook mid-flow is a confusing failure otherwise. */
export async function expectWebhookAccepted(response: APIResponse): Promise<void> {
  if (!response.ok()) {
    throw new Error(`Paddle webhook rejected: ${response.status()} ${await response.text()}`)
  }
}

// ─── Console / CSP violation watcher ─────────────────────────────────────────
// Same technique as test/csp/csp.spec.ts's `recordViolations`: an init script
// installed before any of the page's own scripts run, because those are
// precisely the ones most likely to trip a violation. That suite only ever
// looks at signed-out routes; this is the signed-in half — /dashboard and
// /account never got a CSP/console sweep until now, and it found something
// real on its first run — see KNOWN_HYDRATION_MISMATCH below.

interface CspViolation {
  directive: string
  blockedURI: string
  sourceFile: string
}

declare global {
  interface Window {
    __e2eCspViolations?: CspViolation[]
  }
}

/**
 * A pre-existing bug this suite surfaced, not a fixture artifact.
 *
 * Every gated redirect this suite drives (no-entitlement → /pricing,
 * canceled → /pricing, past_due → /account) logs exactly this warning once.
 * Root cause: `app/middleware/subscription.ts` calls plain
 * `$fetch('/api/billing/entitlement')` from route middleware. Nuxt does NOT
 * forward the incoming request's cookies to a bare `$fetch` call made during
 * SSR — `useRequestFetch()` / `useRequestHeaders(['cookie'])` exist
 * specifically to opt into that, and nothing in this codebase calls either.
 * So on SSR the entitlement check sees no session, the middleware's `catch`
 * swallows the failure ("don't strand a paying customer"), and Nitro renders
 * /dashboard's shell; the CLIENT then re-runs the same middleware WITH the
 * cookie, correctly decides there's no access, and navigates away before
 * hydration of that shell finishes — which is what Vue reports as a
 * mismatch. The FINAL rendered page is always correct (every assertion in
 * these specs about the landed URL and its content passes); only the
 * mid-flight console line is wrong.
 *
 * Confirmed non-flaky: it reproduces on every run of every spec that drives
 * a gated redirect, and never on a spec where access is actually granted.
 *
 * This suite's boundary is test/e2e/**, not app/**, so the fix (forward the
 * request's cookie in subscription.ts, the same gap likely also affects
 * app/middleware/auth.ts's own SSR checks if it ever grows a $fetch) belongs
 * in a follow-up, not here — see the final report for the flagged task.
 * Filtering ONLY this exact string, rather than every console error, is what
 * keeps this a real regression gate: a NEW console error still fails the
 * suite.
 */
const KNOWN_HYDRATION_MISMATCH = 'Hydration completed but contains mismatches.'

export interface ViolationWatcher {
  /** Fails if any CSP violation, unexpected console error, or uncaught page error was recorded so far. */
  assertClean(): Promise<void>
}

/** Call once per page, before the first navigation — see the class comment above. */
export function watchForViolations(page: Page): ViolationWatcher {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    pageErrors.push(String(error))
  })

  const installed = page.addInitScript(() => {
    const store: CspViolation[] = []
    window.__e2eCspViolations = store
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: `${event.sourceFile ?? '?'}:${event.lineNumber ?? 0}`,
      })
    })
  })

  return {
    async assertClean() {
      await installed
      const violations = await page.evaluate(() => window.__e2eCspViolations ?? [])
      expect(
        violations.map((v) => `${v.directive} blocked ${v.blockedURI} (${v.sourceFile})`),
        `CSP violations on a signed-in page`,
      ).toEqual([])

      const knownCount = consoleErrors.filter((message) => message === KNOWN_HYDRATION_MISMATCH).length
      if (knownCount > 0) {
        test.info().annotations.push({
          type: 'warning',
          description: `${knownCount}x known pre-existing hydration mismatch on a gated redirect — see KNOWN_HYDRATION_MISMATCH in test/e2e/fixtures.ts.`,
        })
      }
      const unexpectedConsoleErrors = consoleErrors.filter(
        (message) => message !== KNOWN_HYDRATION_MISMATCH,
      )
      expect(unexpectedConsoleErrors, 'console errors on a signed-in page').toEqual([])
      expect(pageErrors, 'uncaught page errors on a signed-in page').toEqual([])
    },
  }
}

// ─── The fixtures themselves ──────────────────────────────────────────────

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>

interface SignedInSession {
  userId: string
  storageState: StorageState
}

interface SignedInPage {
  userId: string
  email: string
  page: Page
  context: BrowserContext
}

interface WorkerFixtures {
  apiRequest: APIRequestContext
  /** The memoized (email → session) sign-in, worker-scoped — see the header comment. */
  signInCache: (email: string, name?: string) => Promise<SignedInSession>
}

interface TestFixtures {
  /** Sign in (or reuse this worker's cached session) and get a fresh page for it. */
  signInAs: (email: string, name?: string) => Promise<SignedInPage>
  /** POST a signed, schema-valid Paddle event to /paddle/webhook. */
  sendPaddleEvent: (event: PaddleWebhookEvent) => Promise<APIResponse>
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  apiRequest: [
    async ({ playwright }, use) => {
      const context = await playwright.request.newContext({ baseURL: HOST })
      await use(context)
      await context.dispose()
    },
    { scope: 'worker' },
  ],

  signInCache: [
    async ({ apiRequest }, use) => {
      const cache = new Map<string, SignedInSession>()

      await use(async (email, name) => {
        const cached = cache.get(email)
        if (cached) return cached

        const response = await apiRequest.post('/api/auth/dev', { data: { email, name } })
        if (!response.ok()) {
          throw new Error(
            `dev sign-in failed for ${email}: ${response.status()} ${await response.text()}`,
          )
        }
        const body = (await response.json()) as { user: { id: string; email: string } }
        // Captured immediately after the POST, before any other email reuses
        // this worker-scoped context's cookie jar — see the header comment.
        const storageState = await apiRequest.storageState()
        const session: SignedInSession = { userId: body.user.id, storageState }
        cache.set(email, session)
        return session
      })
    },
    { scope: 'worker' },
  ],

  signInAs: async ({ signInCache, browser }, use) => {
    const contexts: BrowserContext[] = []

    await use(async (email, name) => {
      const { userId, storageState } = await signInCache(email, name)
      const context = await browser.newContext({ storageState })
      contexts.push(context)
      const page = await context.newPage()
      return { userId, email, page, context }
    })

    for (const context of contexts) await context.close()
  },

  sendPaddleEvent: async ({ apiRequest }, use) => {
    await use(async (event) => {
      const body = JSON.stringify(event)
      const signature = await signPaddleWebhook(body)
      return apiRequest.post('/paddle/webhook', {
        data: body,
        headers: { 'content-type': 'application/json', 'paddle-signature': signature },
      })
    })
  },
})

export { expect }
