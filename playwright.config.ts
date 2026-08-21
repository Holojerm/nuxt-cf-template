// Playwright config — exists solely to run the axe accessibility suite in
// `test/a11y/`. Application logic is tested by Vitest in the `workerd` pool
// (see vitest.config.ts); those two runners don't overlap, which is why the
// specs here are named *.spec.ts while Vitest owns *.test.ts.
//
// axe needs a real browser, not jsdom: the rules that matter most here —
// color-contrast above all — are computed from resolved styles and actual
// layout, and jsdom reports them as "incomplete" rather than pass or fail.

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
if (process.env.TEST_WORKER_INDEX === undefined) console.info(`a11y suite → ${HOST}`)

export default defineConfig({
  testDir: './test/a11y',
  testMatch: '**/*.spec.ts',
  // A failing contrast ratio is deterministic — a retry only hides flake in the
  // harness, and there is nothing here worth retrying.
  retries: 0,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Only kept for failures, so a green run leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

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
