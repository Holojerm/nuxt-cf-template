# Gotchas — silent failure modes

Failures this repo has actually hit that produce **no error**: wrong-file databases, migrations that never run, empty sitemaps, rate limiters that quietly do nothing. If something appears to work but produces no output, or fails only for signed-in users, the answer is probably here.

> **Load this when:** debugging anything that fails quietly, touching D1/migrations/deploy config, adding a cron task or a custom `definePageMeta` key, or working in a git worktree.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

Sharp edges that have bitten this template before — read before forking or before debugging "why doesn't this work."

## Local D1 lives in two places — only one is real

NuxtHub serves the dev DB from `.data/db/sqlite.db`. Wrangler's own local D1 sandbox lives at `.wrangler/state/v3/d1/`. Migrations applied via `wrangler d1 execute --local` or direct writes via `wrangler d1 execute --local` land in the **wrangler** path, which the dev server does NOT read. Seed via `bun seed` (see `scripts/seed.ts`), which uses `bun:sqlite` against the NuxtHub path directly. The two only converge in production.

## Nothing applies migrations to production D1 — you have to

Locally this is invisible: NuxtHub's dev plugin (`applyMigrationsDuringDev`) applies
`server/db/migrations/` to `.data/db/sqlite.db` on every dev boot, so schema changes just
appear. Production has no equivalent.

`wrangler deploy` does not apply D1 migrations, and NuxtHub's `applyMigrationsDuringBuild`
step runs against the **libsql driver's local file on the build machine** (`hub.db` resolves
to `sqlite`/`libsql` here, not the `d1` driver), so it never touches your remote database.
The `.sql` files are copied into `.output/server/db/migrations/` and the generated
`wrangler.json` points `migrations_dir` at them — but nothing ever runs them.

So a deploy that adds a table ships a Worker querying a table that does not exist, and the
failure surfaces as a 500 on a route that worked perfectly in dev. Run it yourself, after
the first deploy and after every schema change:

```bash
bun run db:migrate:remote
```

One wrinkle if you script it: the root `wrangler.toml` sets no `migrations_table`, so that
command tracks state in wrangler's default `d1_migrations`, while the generated
`.output/server/wrangler.json` sets `migrations_table = "_hub_migrations"`. Both work; pick
one and stay on it, because alternating makes each think nothing has been applied.

The **preview** D1 is a second database with the same problem: `bun run db:migrate:preview`.

## NuxtHub deletes `env` from the generated wrangler config

`wrangler.toml` is an input, not the deployed config. `nuxt build` writes
`.output/server/wrangler.json` and wrangler deploys that. Nitro copies your `wrangler.toml`
into it verbatim — bindings, `[triggers]`, `[[queues.*]]` all survive, verified — and then
`@nuxthub/core` rewrites the file on Nuxt's `close` hook (`processWranglerConfigFile`):

- `CLOUDFLARE_ENV=<name>` set → **flattens** `env.<name>` onto the top level (dropping the
  top-level non-inheritable keys, spreading the environment's over what remains), then
  deletes `env`.
- unset → deletes `env`, keeping production's bindings.

Either way **the generated config contains no environments**. So the obvious command,
`wrangler --cwd .output deploy --env preview`, cannot work — there is nothing named
`preview` in the file wrangler reads. The environment is selected **at build time**:
`bun run build:preview` / `bun run deploy:preview`, and in Workers Builds a
`CLOUDFLARE_ENV=preview` *build variable* on the non-production trigger, with the deploy
command left as a plain `wrangler versions upload`.

Two consequences when editing `[env.preview]`:

- **`name` must be set there.** It is inheritable, so without it a preview build produces a
  config still named `my-app` — preview bindings on the production Worker, sharing its
  secrets.
- **NuxtHub's non-inheritable list is not wrangler's.** `ratelimits` is absent from it, so an
  environment that omits `[[env.preview.ratelimits]]` silently inherits production's
  `namespace_id` and shares its counters. The block is required, not optional.

## A cron task needs the same string in two files

`nitro.scheduledTasks` (nuxt.config.ts) maps a cron expression to task names; `[triggers]
crons` (wrangler.toml) tells Cloudflare when to fire. The join is an **exact string match**
on the expression, so `"0 4 * * *"` and `"0 04 * * *"` are different keys — Cloudflare wakes
the Worker on schedule, `runCronTasks` finds nothing, and the handler returns success. No
error, no log line. If a task never runs, compare those two strings before anything else.

No custom Worker entry is needed for either background surface: the `cloudflare_module`
preset already exports `scheduled()` (which calls `runCronTasks` when
`nitro.experimental.tasks` is on) and `queue()` (which dispatches the `cloudflare:queue`
Nitro hook), plus `email`, `tail` and `trace`. Hook them from `server/plugins/`; do not
hand-write an entry that re-exports `fetch`, because it will rot the next time Nitro changes
one of them.

Note that Nitro **skips scheduled tasks under vitest** (`isTest` in its task runtime). Put
the logic in a `server/utils/` function that takes `db` (and any binding it needs) as an
argument and test that, as `server/utils/purge.ts` does — a test driving the task wrapper
tests the shim. For the same reason, a task must import `db`/`blob` **explicitly** from
`@nuxthub/db` / `@nuxthub/blob` rather than relying on the auto-imports: a task is an
untested bundling surface that runs unattended, and the `kv is not defined` failure in
the gotcha above would surface as a cron event failing nightly with nobody watching.

Anything the sweep filters on needs an **index**. `purge.ts` matches `expires_at` /
`used_at` / `status`, and a `LIMIT` bounds rows *deleted*, not rows *examined* — so an
unindexed predicate full-scans the table on every tick and gets slower as the product
grows. Both credential tables got theirs in migration 0012.

## @nuxt/content's default SQLite driver crashes `bun run` in postinstall

Content v3 needs a local SQLite for parsing and for `nuxt dev`, and its default connector is
`better-sqlite3` — a native module this repo does not depend on. When it is missing, the module
does not fail; it **prompts on stdin** to install it. Under `bun run` there is no usable TTY,
so consola throws `uv_tty_init returned EINVAL` and `nuxt prepare` dies during postinstall.
Observed on a clean `bun install` before `content.experimental.sqliteConnector` was set.

`nuxt.config.ts` pins `sqliteConnector: 'native'` — Node's built-in `node:sqlite`, hence the
`node >= 22.13` line in `engines`. **22.13**, not the 22.5.0 that first shipped `node:sqlite`:
it was behind `--experimental-sqlite` until 22.13.0 / 23.4.0, and on 22.5–22.12 the module's
availability probe returns false and falls straight back to the better-sqlite3 prompt — so the
wrong Node reads as the same confusing crash rather than as a version error.
Note the module's own Bun detection cannot help here either:
`bun run dev` and `bun run build` both shell out to the `nuxt` bin, which has a node shebang,
so `process.versions.bun` is undefined by the time the connector is chosen.

That makes the Node version a **deploy-environment** constraint, not just a local one: CI runs
`bun run ci`, which runs `nuxt build`, which is Node. Workers Builds defaults to Node 24 and
preinstalls 22 and 24, so it passes today. The committed `.node-version` pins it anyway, so
that a future image default — or someone setting `NODE_VERSION=20` for an unrelated reason —
cannot quietly reintroduce the prompt. `engines` is documentation here, not a gate: bun warns
on a mismatch rather than refusing to install. Workers Builds reads `.node-version`, `.nvmrc`,
or a `NODE_VERSION` build variable.

Production is unaffected — there the store is D1 (`content.database`), not a file.

## The dev server caches its DB connection — external writes need a restart

`bun seed` (and anything else writing to `.data/db/sqlite.db` with `bun:sqlite`) writes the file
correctly, but a **running** dev server keeps its own libsql connection and will keep returning
the old rows. Observed directly: insert an entitlement while `bun dev` is up and
`/api/billing/entitlement` still reports `active: false`, with the row plainly visible in the
file. Restart the dev server (or touch `nuxt.config.ts`) and it appears immediately.

So: seed before starting the dev server, or restart after seeding. Don't go debugging the query.

## nuxt-auth-utils uses `/api/_auth/session` (underscore)

`useUserSession()`'s `fetch()` and `clear()` calls hit `/api/_auth/session` — note the underscore. The global auth middleware allowlist must include `/api/_auth/` or sign-out and session refresh will 401. OAuth callback routes you write yourself live under `/api/auth/` (no underscore) and need their own allowlist entry.

## NuxtHub's `kv` auto-import doesn't reach every file at runtime

`kv` (the unstorage handle for the KV binding) is declared in `.nuxt/types/nitro-imports.d.ts`, so
it **typechecks** anywhere in `server/`. It is not always **injected** at runtime: in
`server/utils/rate-limit.ts` it resolved to `ReferenceError: kv is not defined` while the build,
typecheck, and lint were all green. Because the rate limiter fails open by design, the only symptom
was a `rate_limit_unavailable` line in the logs — the feature was simply off.

Import it explicitly (`import { kv } from '@nuxthub/kv'`) in server utils. More generally: when a
NuxtHub auto-import is load-bearing, check the running logs, not just the type checker.

## Custom `definePageMeta` keys need two opt-ins, and fail silently without them

`sitemap.xml` and `llms.txt` are built from `definePageMeta({ publicPage: … })`, collected by
a hook in `nuxt.config.ts`. Three things have to be right, and getting any of them wrong
produces an **empty sitemap** rather than an error:

1. **`experimental.extraPageMetaExtractionKeys: ['publicPage']`.** Nuxt's build-time
   `definePageMeta` scanner only extracts a fixed allowlist (`name`, `path`, `middleware`, …).
   Without this, a custom key is discarded and replaced with a `__nuxt_dynamic_meta_key`
   marker — the hook then sees every page as unmarked.
2. **Collect in `pages:resolved`, not `pages:extend`.** Extraction happens *between* the two
   hooks. In `pages:extend`, `page.meta` is still `null` for every page.
3. **Write to the Nitro instance too.** Nitro is already initialised by `pages:resolved`, so
   `nuxt.options.runtimeConfig` alone is too late; `useNitro().options.runtimeConfig` is what
   ends up in the bundle. `nuxt.config.ts` sets both.

Also: values must be JSON-serializable *literals*. An interpolated string or a referenced
constant fails `isSerializable` and is dropped, silently, the same way.

## NuxtUI v4 needs an explicit CSS entry

`app/assets/css/main.css` must contain `@import "tailwindcss"; @import "@nuxt/ui";` and be listed under `css:` in `nuxt.config.ts`. Without this, NuxtUI's generated theme (`.nuxt/ui.css`) doesn't get bundled — pages render in browser default fonts/colors with no Tailwind utilities working. Already wired up in this template; don't remove either piece.

## Parallel agent worktrees are supported — keep them that way

Agents can work in isolated git worktrees under `.claude/worktrees/<name>` (gitignored), several
at once. Everything in `bun run ci` is scoped to the checkout it runs in, so a sibling worktree
full of half-finished or deleted code cannot contaminate your run. That is a property worth
stating, because it is easy to break and the breakage is confusing rather than loud.

How each gate stays scoped — **match this when you add a gate**:

| Gate | Why a sibling worktree can't reach it |
| --- | --- |
| `lint` | `.oxlintrc.json` › `ignorePatterns` lists `.claude/**` |
| `design:check` / `seo:check` / `brand:check` | Walk `ROOT/app`, `ROOT/app/pages`, `ROOT/content/blog`, and fixed root-relative asset paths |
| `test` | `vitest.config.ts` › `include` is `test/**` + `server/**`, relative to the checkout |
| `typecheck` | Nuxt's generated `.nuxt/tsconfig.*` use scoped includes (`../app/**/*`, `../server/**/*`), not a root glob |
| `test:a11y` | Per-checkout port — see below |
| `build` | Nuxt only reads `app/`, `server/`, `shared/` |

Three rules follow, and each one exists because something broke it:

1. **A gate takes its scan root from the checkout** — not a walk upward, not a bare `**/*` glob.
2. **A gate that binds a port derives it** via `scripts/worktree-port.ts`. Never hardcode one.
3. **A gate never writes to a tracked file.** `nuxt-mcp` rewrites `.mcp.json` with the live dev
   server URL on every boot, and `test:a11y` boots one — so a green run used to end with a dirty
   tree, and `git add -A` would commit a throwaway port. It's now disabled whenever
   `NUXT_DEVTOOLS=false` (`nuxt.config.ts` › `modules`), which is exactly the automated case.

## `bun dev` gets a per-worktree hostname

`bun dev` runs `scripts/dev.ts`, which hands portless an explicit hostname instead of letting it
infer one: the bare configured name in the main checkout (`my-app.localhost` — unchanged), and
`<worktree-dir>.my-app.localhost` in a linked worktree. It prints the host on startup.

The wrapper exists because portless's own worktree prefix is derived from the **branch**, and a
branch is not a unique key for a worktree. Three ways that collides, all of them silent:

| Case | portless alone | Why it happens |
| --- | --- | --- |
| Worktree checked out on `main` | `my-app.localhost` — same as the main checkout | `main`/`master` are treated as default branches and skipped |
| Detached-HEAD worktree | `my-app.localhost` | Branch reads as `HEAD`, also skipped — and Claude Code creates detached worktrees |
| `feat/magic-link` vs `claude/magic-link` | both `magic-link.my-app.localhost` | The prefix is only the branch's last path segment |

The worktree *directory* has none of those problems: git won't create two worktrees at one path,
so it's unique by construction and — unlike the branch — doesn't change under you. That's what
keeps the URL stable when you switch branches inside a worktree.

`scripts/dev.ts` uses the positional `portless <name> <cmd>` form, which takes the name verbatim.
`portless run --name` would stack its branch prefix on top: still unique, but the hostname would
move every time the branch did. `bun dev:app` bypasses the proxy entirely.

> **Historical note.** This section used to warn that `vue-tsc` picked up `.claude/worktrees/`
> and to fix it with `rm -rf .claude/worktrees/<old>`. That is no longer true on Nuxt 4.5: the
> generated tsconfigs scope their includes, and a worktree containing deliberately unbuildable
> code now passes `bun typecheck` untouched. Believing the old note is the more expensive
> mistake, because it argues against running agents in parallel at all.

## Workers Builds: dashboard Worker name must match `wrangler.toml`

CI/CD runs on Cloudflare Workers Builds (repo connected in the dashboard under Worker → Settings → Build). The Worker's name in the dashboard must exactly match `name` in the root `wrangler.toml`, or every build fails before it starts. When you fork and rename the project, reconnect the repo to a Worker with the new name. Build settings live in the dashboard, not in the repo: build command `bun run ci`, deploy command `bunx wrangler --cwd .output deploy`, preview deploy command (non-production branches) `bunx wrangler --cwd .output versions upload`. `NUXT_SESSION_PASSWORD` must be set as a build variable there too — the old GitHub Actions secrets are gone.

## The browser suites run in GitHub Actions, NOT in `bun run ci`

They used to be in `ci`. They were moved on 2026-08-22, because Workers Builds
**cannot run a browser** and the two documented fixes were both tried and both failed —
so don't move them back without reading this.

What was observed, on every branch, since the moment the repo was connected:

```
error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file
  at globalSetup (test/warmup/global-setup.ts:36:34)
```

The build image ships no Chromium system libraries. The documented fix is
`playwright install --with-deps chromium`, and it cannot work either, because the
image is non-root:

```
$ playwright install --with-deps chromium
Switching to root user to install dependencies...
Password: su: Authentication failure
```

So `.github/workflows/browser-suites.yml` runs `bun run ci:browser` on GitHub's
ubuntu runners, where `--with-deps` succeeds. Everything else stayed in Workers
Builds: lint, the design/brand/mirror/seo gates, typecheck, the unit tests and the
build. Those block a **deploy**; the browser suites block a **merge**.

**`test:a11y` is THREE Playwright projects, not one** — `a11y`, `csp` and `e2e`. So the
Content-Security-Policy gate now lives in the Action too. That is the trap: a broken CSP
fails silently, in exactly the way that gate exists to catch. Deleting that workflow
deletes the CSP gate, and nothing will tell you.

The other half of the original note still stands: because the *build command* lives in the
Cloudflare dashboard rather than the repo, a fork cannot fix this by editing `ci` alone —
which is why the fix is a workflow file, something a fork inherits automatically.
- **The suite starts its own dev server** (`playwright.config.ts` → `webServer`) with
  `reuseExistingServer: false`. That is deliberate: it only produces valid results against a
  server started with `NUXT_DEVTOOLS=false`, and reusing a dev server you already had running
  reports the devtools panel's own markup as your app's violations. So a stale process on the
  suite's port makes the run fail to boot rather than silently lie — kill it, don't flip
  `reuseExistingServer`.
- **The port is derived from the checkout path**, not fixed (`scripts/worktree-port.ts`,
  range 3100–3899). Every worktree gets its own, so parallel agents don't collide and a
  `bun run dev:app` on 3000 doesn't either. It's deterministic, so the same checkout always
  gets the same port and you can open it by hand mid-run — `bun run test:a11y` prints it.
  Set `A11Y_PORT` to pin a value. Any future suite that binds a port must use this helper.
- **The `webServer.timeout` is sized for a cold cache, not your machine.** A cold `nuxt dev`
  builds the whole app before it listens; anything that invalidates the Nuxt build cache
  (editing `nuxt.config.ts`, a merge that touches it) puts you back on that path. Observed:
  a 120s budget timed out on the first run after such a merge, and the very next warm boot
  took 2s. CI is *always* cold, so the budget is 300s and the server runs with
  `NUXT_TYPECHECK=false` to keep vue-tsc off the critical path — `bun run ci` has already
  typechecked by then.

## Don't add `nuxt-mcp-toolkit` config under `mcp:` in `nuxt.config.ts`

If you ever pull in `@nuxtjs/mcp-toolkit` (not currently installed), its `ModuleOptions` augmentation doesn't surface as a top-level `mcp:` key in `defineNuxtConfig` — TypeScript will reject it. Configure via `defineMcpHandler` in `server/mcp/index.ts` instead. <!-- refs-check-ignore: hypothetical, the module is not installed -->

