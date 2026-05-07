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
| Deployment | Wrangler → Cloudflare Workers |
| CI/CD | GitHub Actions (lint → typecheck → deploy) |

---

## Fork & deploy in 5 steps

### 1. Rename the project

`my-app` is the placeholder name. Update it in **three places**:

**[`wrangler.toml`](./wrangler.toml):**

```toml
name = "my-app"              # Worker name
database_name = "my-app-db"  # D1 database name
bucket_name = "my-app-blob"  # R2 bucket name

NUXT_PUBLIC_APP_NAME = "My App"  # Display name shown in the UI
```

**[`package.json`](./package.json) — `db:migrate` scripts hardcode the D1 name, and the `portless` key sets the local URL:**

```json
"db:migrate": "wrangler d1 migrations apply my-app-db --local",
"db:migrate:remote": "wrangler d1 migrations apply my-app-db --remote",
"portless": "my-app"
```

(The wrangler `migrations apply` subcommand takes the database name, not the binding, so it has to be hardcoded. The `portless` value controls your local dev URL — see [Local development with portless](#local-development-with-portless-optional) below.)

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

### 4. Add GitHub Actions secrets

In your repo → **Settings → Secrets and variables → Actions**, add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NUXT_SESSION_PASSWORD`

### 5. Run locally and deploy

```bash
bun install
bun db:migrate     # Apply initial migration to local D1
bun dev            # Start dev server with local Cloudflare emulator
```

Push to `main` to trigger a production deploy via GitHub Actions, or deploy manually:

```bash
bun run deploy     # Note: NOT `bun deploy` — that's reserved by Bun
```

---

## Local development with portless (optional)

Running multiple Nuxt projects (or multiple AI agents) at the same time, they all default to port 3000 and collide. [portless](https://portless.sh) gives each project a stable named URL like `https://my-app.localhost` and a random backend port, so they coexist.

**One-time install** (macOS or Linux only — no Windows support):

```bash
npm install -g portless
```

**Run the project through portless instead of `bun dev`:**

```bash
portless          # → https://my-app.localhost
```

`portless` reads the `"portless"` key in `package.json` for the URL name, then runs the `dev` script through its proxy. First run will request `sudo` once to bind port 443 and trust a local CA for HTTPS. `bun dev` still works unchanged for anyone not using portless.

> **Note on the Nuxt MCP server:** [`.mcp.json`](./.mcp.json) points the `nuxt` SSE server at `http://localhost:3000/__mcp/sse`. When you switch to portless, change that URL to `https://my-app.localhost/__mcp/sse` (using your renamed project name).

---

## Common commands

```bash
bun dev               # Start dev server (local Cloudflare emulator)
bun build             # Build for Cloudflare
bun lint              # Run oxlint
bun lint:fix          # Auto-fix lint issues
bun format            # Format with oxfmt
bun typecheck         # TypeScript type checking
bun db:generate       # Generate Drizzle migration after schema changes
bun db:migrate        # Apply migrations to local D1 (via wrangler)
bun db:migrate:remote # Apply migrations to remote/prod D1
bun db:studio         # Open Drizzle Studio (visual DB browser)
bun run deploy        # Build + deploy to Cloudflare (`bun deploy` is reserved by Bun)
```

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
├── .claude/            # Claude Code config (commands, skills, MCP)
├── .github/workflows/  # CI/CD
├── wrangler.toml       # Cloudflare config (rename project here)
└── CLAUDE.md           # AI development guide
```

---

## How the build / deploy actually works

`bun run deploy` does **two** things:

1. `nuxt build` — produces `.output/` with the Cloudflare Workers preset (set in `nuxt.config.ts: nitro.preset = 'cloudflare_module'`).
2. `wrangler --cwd .output deploy` — uploads the built worker.

The Cloudflare preset has to be pinned in `nuxt.config.ts`; the `@nuxthub/core` module does **not** auto-detect it for `nuxt build` (it only auto-detected in the legacy `nuxthub deploy` command, which Cloudflare sunset Feb 2026).

---

## Auth

Session-based auth is pre-wired via `nuxt-auth-utils`. The server middleware in [`server/middleware/auth.ts`](./server/middleware/auth.ts) protects all `/api/*` routes except `/api/health` and `/api/auth/`.

To add OAuth (Google, GitHub, etc.), add the provider credentials to `.env` and create an OAuth callback route. See [nuxt-auth-utils docs](https://github.com/atinux/nuxt-auth-utils).

---

## Claude Code setup

This template ships with Claude Code configuration out of the box:

- **MCP servers** (`.mcp.json`): Cloudflare docs, NuxtUI docs, Drizzle schema introspection, Nuxt live introspection, GitHub
- **Slash commands** (`.claude/commands/`): `/new-feature`, `/scaffold-component`, `/scaffold-api`, `/db-migrate`
- **Skills** (`.claude/skills/`): NuxtUI, frontend design, theming, and more
- **AI guide** (`CLAUDE.md`): stack conventions, patterns, and rules for AI-assisted development

The Nuxt MCP server (`localhost:3000/__mcp/sse`) requires `bun dev` to be running. Everything else works without any extra setup.
