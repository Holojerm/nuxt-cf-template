# nuxt-cf-template

A production-ready template for full-stack apps on **Nuxt 4 + Cloudflare Workers**.

| Layer | Technology |
|---|---|
| Framework | Nuxt 4 |
| UI | NuxtUI v4 + Tailwind CSS v4 |
| Backend | Cloudflare Workers (via NuxtHub + Nitro) |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| KV / Cache | Cloudflare KV |
| File Storage | Cloudflare R2 |
| Auth | nuxt-auth-utils (sealed sessions, OAuth) |
| Linting | oxlint + oxfmt |
| Validation | Zod |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` (real `workerd` runtime, real bindings) |
| Deployment | Wrangler → Cloudflare Workers |
| CI/CD | Cloudflare Workers Builds (lint → typecheck → test → build → deploy) |

---

## Fork & deploy in 5 steps

### 1. Rename the project

`my-app` is the placeholder name. Update it in **three files** (four if you deploy the [MCP worker](#mcp-server-optional-second-worker) — its `mcp/wrangler.jsonc` and `mcp/package.json` use `my-app-mcp` / `my-app-db`):

**[`wrangler.toml`](./wrangler.toml):**

```toml
name = "my-app"              # Worker name
database_name = "my-app-db"  # D1 database name
bucket_name = "my-app-blob"  # R2 bucket name

NUXT_PUBLIC_APP_NAME = "My App"  # Display name shown in the UI
```

**[`package.json`](./package.json) — `db:migrate` scripts hardcode the D1 name, and the `portless.name` field sets the local dev URL:**

```json
"db:migrate": "wrangler d1 migrations apply my-app-db --local",
"db:migrate:remote": "wrangler d1 migrations apply my-app-db --remote",
"portless": { "name": "my-app", "script": "dev:app" }
```

**[`.mcp.json`](./.mcp.json) — the Nuxt MCP server URL:**

```json
"nuxt": { "type": "sse", "url": "https://my-app.localhost/__mcp/sse" }
```

(The wrangler `migrations apply` subcommand takes the database name, not the binding, so it has to be hardcoded. `portless.name` and the MCP URL must match — they both share the same `<name>.localhost` host.)

### 2. Create Cloudflare resources

In your [Cloudflare dashboard](https://dash.cloudflare.com), create:

- **D1 database** → copy the database ID into `wrangler.toml`
- **KV namespace** → copy the namespace ID into `wrangler.toml`
- **R2 bucket** → name must match `bucket_name` in `wrangler.toml`

```toml
[[d1_databases]]
database_id = "paste-your-d1-id-here"

[[kv_namespaces]]
id = "paste-your-kv-id-here"
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Fill in `.env` for local development:

```
NUXT_SESSION_PASSWORD=   # 32+ char random string: openssl rand -base64 32
CLOUDFLARE_API_TOKEN=    # Cloudflare API token with Workers + D1 + KV + R2 edit perms
CLOUDFLARE_ACCOUNT_ID=   # Your Cloudflare account ID
```

Set the session password as a Worker secret (required for production):

```bash
bunx wrangler secret put NUXT_SESSION_PASSWORD
```

### 4. Connect Workers Builds (CI/CD)

CI/CD runs on [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), Cloudflare's native build system — no GitHub Actions, no API tokens to rotate. In the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages):

1. Select (or create) the Worker — its name **must match** `name` in `wrangler.toml`.
2. Go to **Settings → Build → Connect** and pick this repository.
3. Configure the build:
   - **Build command**: `bun run ci` (lint → typecheck → test → build)
   - **Deploy command**: `bunx wrangler --cwd .output deploy`
   - **Preview deploy command**: `bunx wrangler --cwd .output versions upload`
4. Under **Build Variables and Secrets**, add `NUXT_SESSION_PASSWORD` (mark it secret).
5. Enable **non-production branch builds** (Settings → Build → Branch control) to get build checks and preview URLs on every PR.

Every push to `main` now lints, typechecks, tests, builds, and deploys. Pushes to other branches run the same checks and post a preview URL as a PR comment.

### 5. Run locally and deploy

```bash
bun install
bun db:migrate     # Apply initial migration to local D1
bun dev            # Start dev server at https://my-app.localhost (via portless)
```

> **First-run note:** `bun dev` runs through [portless](https://portless.sh) so multiple Nuxt projects (and AI agents) can run side-by-side without colliding on port 3000. The first invocation will request `sudo` once to bind port 443 and trust a local CA for HTTPS. Subsequent runs are silent. **macOS / Linux only — no Windows support.**

Push to `main` to trigger a production deploy via Workers Builds, or deploy manually:

```bash
bun run deploy     # Note: NOT `bun deploy` — that's reserved by Bun
```

---

## Common commands

```bash
bun dev               # Start dev server at https://my-app.localhost (via portless)
bun dev:app           # Start dev server directly on http://localhost:3000 (bypass portless)
bun build             # Build for Cloudflare
bun lint              # Run oxlint
bun lint:fix          # Auto-fix lint issues
bun format            # Format with oxfmt
bun typecheck         # TypeScript type checking
bun run ci            # Lint + typecheck + test + build — what Workers Builds runs on every push
bun db:generate       # Generate Drizzle migration after schema changes
bun db:migrate        # Apply migrations to local D1 (via wrangler)
bun db:migrate:remote # Apply migrations to remote/prod D1
bun db:studio         # Open Drizzle Studio (visual DB browser)
bun run test          # Run Vitest in workerd via @cloudflare/vitest-pool-workers
bun test:watch        # Same, in watch mode
bun run deploy        # Build + deploy to Cloudflare (`bun deploy` is reserved by Bun)
```

> **Note:** use `bun run test`, not `bun test`. The bare form invokes Bun's built-in test runner, which doesn't know about Vitest or the Cloudflare pool.

---

## Project structure

```
/
├── app/
│   ├── components/     # Reusable UI components (group by feature)
│   ├── composables/    # Shared stateful logic
│   ├── layouts/        # Page layouts (default.vue included)
│   ├── pages/          # File-based routing
│   └── types/          # Frontend-only TypeScript types
├── server/
│   ├── api/            # API routes (filename = endpoint + method)
│   ├── db/
│   │   ├── schema.ts   # Single source of truth for DB schema
│   │   └── migrations/ # Generated by drizzle-kit
│   └── middleware/     # Server middleware (auth guard included)
├── mcp/                # Optional second worker: remote MCP server (OAuth + shared D1)
├── test/               # Vitest tests (workerd-runtime, real CF bindings)
├── .claude/            # Claude Code config (commands, skills, MCP)
├── .github/            # Dependabot config (CI/CD lives in Cloudflare Workers Builds)
├── vitest.config.ts    # Vitest + @cloudflare/vitest-pool-workers config
├── wrangler.toml       # Cloudflare config (rename project here)
└── CLAUDE.md           # AI development guide
```

---

## Testing

Tests run inside the same `workerd` runtime that Cloudflare runs in production, via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/). D1, KV, and R2 bindings are real (in-memory, isolated per test file) and reached through the `cloudflare:test` import:

```ts
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('users table', () => {
  it('round-trips a row through D1', async () => {
    await env.DB.prepare('CREATE TABLE t (x TEXT)').run()
    await env.DB.prepare('INSERT INTO t VALUES (?)').bind('hi').run()
    const row = await env.DB.prepare('SELECT x FROM t').first<{ x: string }>()
    expect(row?.x).toBe('hi')
  })
})
```

For testing helpers that use the auto-imported `db` (the Drizzle client), construct a Drizzle instance from `env.DB` inside the test:

```ts
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/server/db/schema'

const db = drizzle(env.DB, { schema })
```

See [`test/example.test.ts`](./test/example.test.ts) for the starter pattern. Co-located tests under `server/**/*.test.ts` are also picked up by the default config.

---

## How the build / deploy actually works

`bun run deploy` does **two** things:

1. `nuxt build` — produces `.output/` with the Cloudflare Workers preset (set in `nuxt.config.ts: nitro.preset = 'cloudflare_module'`).
2. `wrangler --cwd .output deploy` — uploads the built worker.

The Cloudflare preset has to be pinned in `nuxt.config.ts`; the `@nuxthub/core` module does **not** auto-detect it for `nuxt build` (it only auto-detected in the legacy `nuxthub deploy` command, which Cloudflare sunset Feb 2026).

Workers Builds runs the same two steps in CI — `bun run ci` covers the build (plus lint, typecheck, and tests), and the deploy command is the same `wrangler --cwd .output deploy`. Builds run inside your Cloudflare account, so CI needs no API token.

---

## Auth

Session-based auth is pre-wired via `nuxt-auth-utils`. The server middleware in [`server/middleware/auth.ts`](./server/middleware/auth.ts) protects all `/api/*` routes except `/api/health` and `/api/auth/`.

To add OAuth (Google, GitHub, etc.), add the provider credentials to `.env` and create an OAuth callback route. See [nuxt-auth-utils docs](https://github.com/atinux/nuxt-auth-utils).

---

## Billing (Paddle)

Subscription billing is pre-wired for [Paddle](https://www.paddle.com) (merchant of record), sandbox-first. With no Paddle env vars set, all of it no-ops — the template runs fine without a Paddle account.

The pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| Webhook | [`server/routes/paddle/webhook.post.ts`](./server/routes/paddle/webhook.post.ts) | Verifies the `Paddle-Signature` HMAC (see `server/utils/paddle.ts`), upserts `entitlements` on `subscription.*` events. Lives outside `/api/` — the signature is the auth. |
| Entitlements | `entitlements` table in [`server/db/schema.ts`](./server/db/schema.ts) | One row per Paddle subscription, keyed by `paddle_subscription_id`, mapped to a user via checkout `custom_data.userId`. |
| Gating | `requireSubscription(event, productKey?)` in [`server/utils/billing.ts`](./server/utils/billing.ts) | Composes on `requireUserSession`; throws 401 signed-out, 402 unsubscribed. Auto-imported in all server routes. |
| Checkout | `usePaddle()` in [`app/composables/usePaddle.ts`](./app/composables/usePaddle.ts) | Lazy-loads Paddle.js, opens overlay checkout with the signed-in user's email and `custom_data.userId`. |

Setup (sandbox):

1. Create a sandbox account at [sandbox-vendors.paddle.com](https://sandbox-vendors.paddle.com), add a product + price.
2. Client token (Developer tools → Authentication) → `NUXT_PUBLIC_PADDLE_CLIENT_TOKEN`, keep `NUXT_PUBLIC_PADDLE_ENV=sandbox`.
3. Notification destination (Developer tools → Notifications) pointing at `https://<your-app>/paddle/webhook`, subscribed to `subscription.*` and `transaction.completed`; its secret → `NUXT_PADDLE_WEBHOOK_SECRET` (via `wrangler secret put` in prod, `.env` in dev).
4. In a page: `const { openCheckout } = usePaddle()` then `openCheckout('pri_…')`. Gate API routes with `await requireSubscription(event)`.

Going live: swap the token/secret for live ones and set `NUXT_PUBLIC_PADDLE_ENV=production`.

---

## MCP server (optional second worker)

[`mcp/`](./mcp) is a self-contained second Worker exposing a **remote MCP server** (Streamable HTTP at `/mcp`) that agents like Claude Code, Claude.ai, and Cursor can connect to with just the URL. It's optional — ignore the directory if your app doesn't need one.

How it hangs together:

- **OAuth 2.1** via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (dynamic client registration included, so MCP clients self-register). Tokens/grants live in the worker's own `OAUTH_KV` namespace.
- **Identity bridge** (`mcp/src/authorize.ts`): device-code style. A signed-in user mints a single-use, 10-minute connect code in the app (`POST /api/mcp/connect-code` — only its SHA-256 hash is stored), pastes it into the worker's `/authorize` consent page, and their `userId` is sealed into the OAuth grant. No shared cookies, no upstream IdP.
- **Tools** (`mcp/src/server.ts`) run on `createMcpHandler` from the [`agents` SDK](https://developers.cloudflare.com/agents/) (stateless, MCP SDK v2). The authenticated user comes from `getMcpAuthContext()`; `subscription_status` shows the entitlement-gating pattern against the shared `entitlements` table.
- **Shared D1**: the worker binds the *same* `database_id` as the Nuxt app (D1 bindings are shareable). The app owns schema + migrations; the worker reads with plain SQL.

Commands (from the repo root): `bun run mcp:dev`, `bun run mcp:typecheck`, `bun run mcp:deploy` (run `bun install` inside `mcp/` first — it has its own lockfile-less package.json). The wrangler scripts pass `-c wrangler.jsonc` explicitly because the parent app's build writes a deploy-config redirect (`.wrangler/deploy/config.json`) that otherwise confuses wrangler.

Deploying it for real: create a KV namespace for `OAUTH_KV`, paste the app's D1 `database_id` into `mcp/wrangler.jsonc`, rename `my-app-mcp`, and either `bun run mcp:deploy` locally or add a second Workers Builds project with root directory `mcp/`.

Local dev caveat: `wrangler dev` uses its own local D1 sandbox (`.wrangler/`), not the Nuxt dev server's NuxtHub DB (`.data/`). Hydrate it with `bun run db:migrate:local` (inside `mcp/`) and seed rows by hand, or develop against remote D1.

---

## Claude Code setup

This template ships with Claude Code configuration out of the box:

- **MCP servers** (`.mcp.json`): Cloudflare docs, NuxtUI docs, Drizzle schema introspection, Nuxt live introspection, GitHub
- **Slash commands** (`.claude/commands/`): `/new-feature`, `/scaffold-component`, `/scaffold-api`, `/db-migrate`
- **Skills** (`.claude/skills/`): NuxtUI, frontend design, theming, and more
- **AI guide** (`CLAUDE.md`): stack conventions, patterns, and rules for AI-assisted development

The Nuxt MCP server requires `bun dev` to be running — its URL in `.mcp.json` is `https://<your-portless-name>.localhost/__mcp/sse` (defaults to `my-app`; rename when you fork). Everything else works without any extra setup.
