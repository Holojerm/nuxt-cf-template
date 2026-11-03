// Shared fixtures for the E2E suite: a real session, a unique user per scenario,
// and the console watcher. Nothing here knows about billing (or any other
// optional layer): a layer's own specs live in layers/<name>/test/e2e/ and extend
// `test` from here with what they need (billing adds `sendPaddleEvent`, signed
// Paddle webhooks, in layers/billing/test/e2e/fixtures.ts). playwright.config.ts
// finds them; see test/e2e/layers.ts.
//
// State is driven THROUGH the server instead of around it, because
// .claude/docs/gotchas.md's "The dev server caches its DB connection" entry: `nuxt dev`
// holds its own libsql connection open, and an external `bun:sqlite` write after
// boot is invisible to it until a restart. Sign in via POST /api/auth/dev (the
// same dev-only shortcut a human uses locally) and let each layer's specs create
// their state through the route a real user's action would take.
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
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'

import { playwrightPort } from '../../scripts/worktree-port'
import { recordConsole } from '../lib/console'

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

// ─── Console / CSP violation watcher ─────────────────────────────────────────
// Built on the shared recorder in test/lib/console.ts (also used by
// test/csp/csp.spec.ts, which only ever looks at signed-out routes) — this
// file owns the signed-in policy: every console error is fatal, no exceptions.
//
// There used to be one. This suite's first run found every gated redirect
// logging "Hydration completed but contains mismatches.", because
// billing's subscription route middleware fetched the entitlement during SSR with a
// bare `$fetch`, which sends no cookies — so the server rendered a gated
// shell the client then had to navigate away from mid-hydration. That is
// fixed (it uses `useRequestFetch()` now), the counted tolerance is gone, and
// the server issues the redirect itself.

export interface ViolationWatcher {
  /** Fails if any CSP violation, console error, or uncaught page error was recorded so far. */
  assertClean(): Promise<void>
}

/** Call once per page, before the first navigation. */
export function watchForViolations(page: Page): ViolationWatcher {
  const recorder = recordConsole(page)

  return {
    async assertClean() {
      const violations = await recorder.cspViolations()
      expect(
        violations.map((v) => `${v.directive} blocked ${v.blockedURI} (${v.sourceFile})`),
        `CSP violations on a signed-in page`,
      ).toEqual([])

      const consoleErrors = recorder.messages
        .filter((message) => message.type() === 'error')
        .map((message) => message.text())

      expect(consoleErrors, 'console errors on a signed-in page').toEqual([])
      expect(recorder.pageErrors.map(String), 'uncaught page errors on a signed-in page').toEqual(
        [],
      )
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
})

export { expect }
