// Playwright config — the suites that need a real browser. Application logic is
// tested by Vitest in the `workerd` pool (see vitest.config.ts); those two
// runners don't overlap, which is why the specs here are named *.spec.ts while
// Vitest owns *.test.ts (its `include` globs only `*.test.ts`).
//
// Three suites live here, and all of them are here for the same reason — the
// thing they check does not exist until a browser renders the page:
//
//   test/a11y/  axe. The rules that matter most — color-contrast above all —
//               are computed from resolved styles and actual layout, and jsdom
//               reports them as "incomplete" rather than pass or fail.
//   test/csp/   the Content-Security-Policy (shared/security-headers.ts). A CSP only
//               exists as browser behaviour; nothing short of a real engine can
//               tell you whether the policy you shipped blocks your own app.
//
// They are separate `projects` rather than one directory so each keeps its own
// scope and shows up under its own name in the report — but they deliberately
// share the single `webServer` below, because booting one dev server twice is
// the slowest thing in `bun run ci`.
//
//   test/e2e/    the flows the product exists for, end to end. Unlike the two
//               suites above, it writes real state — a signed-in session —
//               so it needs a real user-per-scenario rather than a fixed
//               route list. Core's specs are the sign-in ones; each optional
//               layer's own specs live in layers/<name>/test/e2e/ and run as
//               their own `e2e-<name>` project (billing: buy → access,
//               cancel → lose access, with signed Paddle webhooks, so it
//               adds its webhook secret to the shared server below).

import { defineConfig, devices } from '@playwright/test'

import { playwrightPort } from './scripts/worktree-port'
import { discoverLayerE2e } from './test/e2e/layers'

// Layers that ship browser specs of their own (billing's money path) contribute
// a project, server environment and warm-ups from layers/<name>/test/e2e/. A repo
// without the layer has none of it. See test/e2e/layers.ts.
const layerE2e = await discoverLayerE2e(import.meta.dirname)

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
  // A failing contrast ratio is deterministic, so a real failure fails twice. One
  // CI retry is for the harness: the suite runs on a merge-queue batch of up to
  // three PRs, and one cold-compile timeout on `nuxt dev` used to eject all
  // three. A test that passes on retry is reported as flaky in the list output,
  // with its first-attempt trace kept, so flake stays visible.
  retries: process.env.CI ? 1 : 0,
  // Deliberately NOT raising the 30s default. The first navigation of a run
  // does blow through it on a cold Vite cache, but paying for that with a
  // bigger budget everywhere makes a genuine hang cost three times as long in
  // every one of eighteen tests, and blunts the one signal this timeout exists
  // to give. `globalSetup` absorbs the cold build once instead.
  fullyParallel: true,
  // Runs after `webServer` (Playwright starts that as a plugin, and plugin
  // setup precedes globalSetup), so the server is reachable by then. Independent
  // warm-ups, run in order: the client bundle (a real page, test/warmup/) first,
  // then the sign-in route every signed-in spec calls first
  // (test/e2e/global-setup.ts), then whatever each layer needs warm (billing's
  // webhook) — unrelated concerns, same array rather than one file doing
  // several things.
  globalSetup: [
    './test/warmup/global-setup.ts',
    './test/e2e/global-setup.ts',
    ...layerE2e.flatMap((layer) => layer.globalSetup),
  ],
  // Pairs with the e2e globalSetup entries above: sweeps the e2e-* rows they
  // (and every E2E spec) write to the local dev DB, so `bun run ci` doesn't
  // grow .data/db/sqlite.db forever. Layers go first, so rows that point at a
  // user are gone before the user is. See test/e2e/global-teardown.ts.
  globalTeardown: [
    ...layerE2e.flatMap((layer) => layer.globalTeardown),
    './test/e2e/global-teardown.ts',
  ],
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: HOST,
    // Only kept for failures, so a green run leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // No `dependencies` on any of these. Warming the dev server's first client
  // build used to be a `warmup` project every other project depended on; it is
  // `globalSetup` now, which happens once for the whole run and needs nothing
  // declared per project — including by the next project someone adds.
  projects: [
    { name: 'a11y', testDir: './test/a11y', use: { ...devices['Desktop Chrome'] } },
    { name: 'csp', testDir: './test/csp', use: { ...devices['Desktop Chrome'] } },
    { name: 'e2e', testDir: './test/e2e', use: { ...devices['Desktop Chrome'] } },
    ...layerE2e.map((layer) => ({
      name: `e2e-${layer.name}`,
      testDir: layer.dir,
      use: { ...devices['Desktop Chrome'] },
    })),
  ],

  webServer: {
    // The dev server rather than the built Worker: `wrangler dev` on .output
    // would need bindings and migrations wired up just to render static
    // marketing pages, and the markup axe sees is the same either way.
    // Measured (2026-11, one worker): axe against `nuxt build` + `wrangler dev`
    // took 22 s build + 17 s run for the a11y project alone, on top of the dev
    // server csp and e2e need anyway; against this server it adds 16 s. The
    // built server saves ~1 s a route and costs a second server and a build.
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
    // A layer's own variables (billing's webhook secret and price ids) come from
    // its e2e.config.ts. They only matter to that layer's project — a11y and csp
    // never call the webhook — but they have to be set here, on the ONE server
    // all the projects share, rather than per-project: Playwright has one
    // `webServer` per config, not one per project.
    env: {
      NUXT_DEVTOOLS: 'false',
      NUXT_TYPECHECK: 'false',
      NUXT_PORT: String(PORT),
      ...Object.assign({}, ...layerE2e.map((layer) => layer.env)),
    },
  },
})
