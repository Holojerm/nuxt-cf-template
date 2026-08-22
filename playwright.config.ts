// Playwright config — the suites that need a real browser. Application logic is
// tested by Vitest in the `workerd` pool (see vitest.config.ts); those two
// runners don't overlap, which is why the specs here are named *.spec.ts while
// Vitest owns *.test.ts (its `include` globs only `*.test.ts`).
//
// Two suites live here, and both are here for the same reason — the thing they
// check does not exist until a browser renders the page:
//
//   test/a11y/  axe. The rules that matter most — color-contrast above all —
//               are computed from resolved styles and actual layout, and jsdom
//               reports them as "incomplete" rather than pass or fail.
//   test/csp/   the Content-Security-Policy in nuxt.config.ts. A CSP only
//               exists as browser behaviour; nothing short of a real engine can
//               tell you whether the policy you shipped blocks your own app.
//
// They are separate `projects` rather than one directory so each keeps its own
// scope and shows up under its own name in the report — but they deliberately
// share the single `webServer` below, because booting one dev server twice is
// the slowest thing in `bun run ci`.

import { defineConfig, devices } from '@playwright/test'

import { playwrightPort } from './scripts/worktree-port'

// Derived from the checkout path rather than fixed at 3000, so parallel git
// worktrees each get their own server. See scripts/worktree-port.ts for why a
// hash beats both a fixed port and a free-port scan. Override with A11Y_PORT.
const PORT = playwrightPort()
const HOST = `http://localhost:${PORT}`

// Printed because the port is derived rather than known: without this the only
// way to open the app while a run is in flight is to recompute the hash.
// Playwright re-imports this config in every worker process, so print only from
// the runner — otherwise the line repeats once per worker in the CI log.
if (process.env.TEST_WORKER_INDEX === undefined) console.info(`browser suites → ${HOST}`)

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  // A failing contrast ratio is deterministic — a retry only hides flake in the
  // harness, and there is nothing here worth retrying.
  retries: 0,
  // Playwright's default is 30s per test, and the FIRST navigation of a run
  // blows through it on a cold Vite cache: `nuxt dev` answers the webServer
  // health check by server-rendering one page, then the browser asks for the
  // client bundle and Vite transforms the whole component tree on demand. That
  // tree grew when @nuxt/content arrived — NuxtUI registers ~40 Prose*
  // components globally as soon as it is installed — and the first `page.goto`
  // started timing out at 30s while every later one took two seconds.
  //
  // Same reasoning as webServer.timeout below: budget for the cold path, which
  // is the only path CI ever takes. A real hang still fails, just later.
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Only kept for failures, so a green run leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'a11y', testDir: './test/a11y', use: { ...devices['Desktop Chrome'] } },
    { name: 'csp', testDir: './test/csp', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    // The dev server rather than the built Worker: `wrangler dev` on .output
    // would need bindings and migrations wired up just to render static
    // marketing pages, and the markup axe sees is the same either way.
    command: 'bun run dev:app',
    url: HOST,
    // Never reuse: this suite only produces valid results against a server
    // started with NUXT_DEVTOOLS=false, and a dev server already on this port
    // was almost certainly started without it. Reusing one silently reports
    // the devtools panel's own markup as this app's violations.
    //
    // This is also why the port above is per-checkout. `false` means a second
    // worktree running the suite does not share the first one's server, it
    // fails to boot — correct, and fatal for parallel agents until each
    // checkout got a port of its own.
    reuseExistingServer: false,
    // CI is always a cold cache, and a cold `nuxt dev` builds the whole app
    // before it listens. 120s was not enough — it timed out on the first run
    // after a merge that touched nuxt.config.ts, while the next warm boot took
    // 2s. Budget for the cold path, not the one you see locally.
    timeout: 300_000,
    // NUXT_TYPECHECK=false keeps vue-tsc off the critical path; `bun run ci`
    // has already typechecked before this suite runs. NUXT_PORT is what makes
    // `nuxt dev` listen on the derived port instead of its own default 3000.
    env: { NUXT_DEVTOOLS: 'false', NUXT_TYPECHECK: 'false', NUXT_PORT: String(PORT) },
  },
})
