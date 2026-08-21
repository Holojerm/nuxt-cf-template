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
| Auth | nuxt-auth-utils — GitHub + Google OAuth, wired end to end |
| Billing | Paddle (merchant of record) — checkout, entitlements, self-serve cancellation |
| Email | Resend over fetch — welcome, receipt, payment-failed, access-ended |
| Linting | oxlint + oxfmt |
| Validation | Zod |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` (real `workerd` runtime, real bindings) |
| Deployment | Wrangler → Cloudflare Workers |
| CI/CD | Cloudflare Workers Builds (lint → typecheck → test → build → deploy) |

---

## Product decisions

**Single-user by design.** This template is a consumer product: one person, one account, one subscription. There are no teams, seats, workspaces, or org switchers, and `entitlements.userId` is the correct shape — not a placeholder for a `team_id`. If you are building B2B, that is a different data model; retrofitting teams onto this one costs more than starting from a B2B starter.

**English-only, deliberately.** The template ships without an i18n layer on purpose: for a consumer SaaS the cost of maintaining translations before you have users in a market is pure overhead, and half-translated UI is worse than honest English. Revisit when a real market signal exists — meaningful non-English traffic in analytics, or a paid-user request pattern — and add `@nuxtjs/i18n` at that point, not speculatively.

---

## Fork & deploy in 5 steps

### 1. Rename the project

```bash
bun run rename acme-widgets --display "Acme Widgets"
```

That rewrites all six occurrences of `my-app` across `wrangler.toml`, `package.json`
(scripts + `portless.name`), `.mcp.json`, and `mcp/`, then prints what's left for you to do
by hand. Missing one of these is not obvious later: Workers Builds refuses every build when
the dashboard Worker name doesn't match `wrangler.toml`, and the Nuxt MCP server just never
connects when its URL doesn't match `portless.name`.

<details>
<summary>What it changes, if you'd rather do it by hand</summary>

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

</details>

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

Only three things are actually required to run:

```
NUXT_SESSION_PASSWORD=   # 32+ char random string: openssl rand -base64 32
CLOUDFLARE_API_TOKEN=    # Cloudflare API token with Workers + D1 + KV + R2 edit perms
CLOUDFLARE_ACCOUNT_ID=   # Your Cloudflare account ID
```

Everything else — OAuth, Paddle, Resend, PostHog — is optional and **degrades instead of
breaking**: an unset provider means that sign-in button doesn't render, an unset Paddle price
means that plan's button is disabled, an unset Resend key means emails are logged no-ops. You
can go all the way through the app before creating a single third-party account.

See `.env.example` for the full list, including the exact OAuth callback URLs to register.

Set the session password as a Worker secret (required for production):

```bash
bunx wrangler secret put NUXT_SESSION_PASSWORD
```

### 4. Connect Workers Builds (CI/CD)

CI/CD runs on [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), Cloudflare's native build system — no GitHub Actions, no API tokens to rotate. In the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages):

1. Select (or create) the Worker — its name **must match** `name` in `wrangler.toml`.
2. Go to **Settings → Build → Connect** and pick this repository.
3. Configure the build:
   - **Build command**: `bun run ci` (lint → design:check → brand:check → seo:check → typecheck → test → a11y → build)
   - **Deploy command**: `bunx wrangler --cwd .output deploy`
   - **Preview deploy command**: `bunx wrangler --cwd .output versions upload`
4. Under **Build Variables and Secrets**, add `NUXT_SESSION_PASSWORD` (mark it secret).
5. Enable **non-production branch builds** (Settings → Build → Branch control) to get build checks and preview URLs on every PR.

Every push to `main` now lints, typechecks, tests, builds, and deploys. Pushes to other branches run the same checks and post a preview URL as a PR comment.

### 5. Run locally and deploy

```bash
bun install
bun dev            # Start dev server at https://my-app.localhost (via portless)
```

NuxtHub applies everything in `server/db/migrations/` to its local database
(`.data/db/sqlite.db`) when the dev server boots, so there is no local migrate step.
`bun db:migrate` targets wrangler's *separate* local sandbox, which the dev server does
not read — see CLAUDE.md › Gotchas.

> **First-run note:** `bun dev` runs through [portless](https://portless.sh) so multiple Nuxt projects (and AI agents) can run side-by-side without colliding on port 3000. The first invocation will request `sudo` once to bind port 443 and trust a local CA for HTTPS. Subsequent runs are silent. **macOS / Linux only — no Windows support.**
>
> Each git worktree gets its own hostname (`<worktree-dir>.my-app.localhost`), printed on startup, so several checkouts — or several agents — can run `bun dev` at once. See CLAUDE.md › Gotchas for why the worktree directory is the key rather than the branch.

Push to `main` to trigger a production deploy via Workers Builds, or deploy manually:

```bash
bun run deploy     # Note: NOT `bun deploy` — that's reserved by Bun
```

> **Migrations do not run on deploy.** Neither `wrangler deploy` nor Workers Builds applies
> them to your remote D1, and NuxtHub's build-time migration step writes to a local file on
> the build machine. After the first deploy — and after every schema change — run this once
> against production, or the Worker will query tables that don't exist:
>
> ```bash
> bun run db:migrate:remote
> ```

---

## Common commands

```bash
bun dev               # Start dev server at https://my-app.localhost (via portless).
                      # In a git worktree: https://<worktree-dir>.my-app.localhost
bun dev:app           # Start dev server directly on http://localhost:3000 (bypass portless)
bun build             # Build for Cloudflare
bun lint              # Run oxlint
bun lint:fix          # Auto-fix lint issues
bun format            # Format with oxfmt
bun typecheck         # TypeScript type checking
bun run brand:generate # Rebuild favicon, app icon, and og.png from the brand mark
bun run brand:check   # Fail if those files no longer match the mark (part of ci)
bun run ci            # Lint + design/brand/seo gates + typecheck + test + test:a11y + build — Workers Builds runs this
bun db:generate       # Generate Drizzle migration after schema changes
bun db:migrate        # Apply migrations to local D1 (via wrangler)
bun db:migrate:remote # Apply migrations to remote/prod D1
bun db:studio         # Open Drizzle Studio (visual DB browser)
bun run rename <name> # Rewrite the my-app placeholder across all six places it appears
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
│   │   └── Brand/      # Logo.vue — the mark, and the only place it is drawn
│   ├── composables/    # Shared stateful logic (usePaddle)
│   ├── layouts/        # Page layouts (default.vue: nav + footer + legal links)
│   ├── middleware/     # Route guards: auth, subscription (UX only — not the boundary)
│   ├── pages/          # File-based routing (landing, pricing, login, account, dashboard, legal)
│   ├── types/          # Frontend-only TypeScript types
│   └── utils/          # Auto-imported client helpers (plans.ts)
├── server/
│   ├── api/
│   │   ├── auth/       # OAuth providers, logout, provider list, dev sign-in
│   │   └── billing/    # Entitlement status + customer-portal link
│   ├── db/
│   │   ├── schema.ts   # Single source of truth for DB schema
│   │   └── migrations/ # Generated by drizzle-kit
│   ├── middleware/     # Auth guard + auth-surface rate limiting
│   ├── routes/         # Non-/api routes: paddle webhook, ingest proxy, robots, sitemap
│   └── utils/          # auth, users, email, rate-limit, entitlements, billing
├── mcp/                # Optional second worker: remote MCP server (OAuth + shared D1)
├── test/               # Vitest tests (workerd-runtime, real CF bindings)
├── .claude/            # Claude Code config (commands, skills, MCP)
├── .github/            # Dependabot config (CI/CD lives in Cloudflare Workers Builds)
├── vitest.config.ts    # Vitest + @cloudflare/vitest-pool-workers config
├── DESIGN.md           # Visual design system — the source of truth, see /design-sync
├── brand.lock.json     # Fingerprint of the generated brand assets (see brand:check)
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

Workers Builds runs the same two steps in CI — `bun run ci` covers the build (plus lint, the design-token and SEO gates, typecheck, unit tests, and the axe accessibility suite), and the deploy command is the same `wrangler --cwd .output deploy`. Builds run inside your Cloudflare account, so CI needs no API token.

---

## Auth

Sign-in works out of the box — GitHub and Google OAuth, users provisioned on first login, and a
dev-only email shortcut so a fresh clone reaches a gated page without registering an OAuth app
first.

| Piece | Where | What it does |
| --- | --- | --- |
| Provider routes | [`server/api/auth/github.get.ts`](./server/api/auth/github.get.ts), [`google.get.ts`](./server/api/auth/google.get.ts) | Start *and* finish the OAuth dance — one route each. Callback URL to register is the route's own path. |
| Sign-in tail | [`server/utils/auth.ts`](./server/utils/auth.ts) | Provisions the user, seals the session, sends the welcome email, redirects. Adding a provider is ~15 lines of profile mapping. |
| Provisioning | [`server/utils/users.ts`](./server/utils/users.ts) | Find-or-create by verified email. Covered by [`test/users.test.ts`](./test/users.test.ts). |
| Which buttons to show | `GET /api/auth/providers` | Reports which providers are configured, so an unconfigured one never renders a button that dead-ends. |
| Dev sign-in | [`server/api/auth/dev.post.ts`](./server/api/auth/dev.post.ts) | Email, no password. `import.meta.dev` is a build-time constant, so the handler is dead code in production and the route 404s. |
| Server guard | [`server/middleware/auth.ts`](./server/middleware/auth.ts) | 401s every `/api/*` route except `/api/health`, `/api/auth/`, `/api/_auth/`. Also rate-limits the auth surface. |
| Client guards | [`app/middleware/auth.ts`](./app/middleware/auth.ts), [`subscription.ts`](./app/middleware/subscription.ts) | `definePageMeta({ middleware: ['auth', 'subscription'] })`. UX only — see below. |

**Identity is the verified email address.** Sign in with GitHub today and Google tomorrow on the
same address and you get the same account, which is what people expect and what avoids duplicate
accounts holding separate subscriptions. That's only safe because every caller passes an explicit
`emailVerified` flag: an unverified address would let someone register the victim's email at a lax
provider and inherit their subscription. Never default that flag to `true`.

**The client middleware is not a security boundary.** It runs in the browser so people see a login
page instead of an empty one. The boundary is `getUserSession` / `requireSubscription` inside the
API routes. Delete the client middleware and a gated page renders empty; delete the server check
and it leaks.

Setting up real OAuth:

1. **GitHub** — Settings → Developer settings → OAuth Apps → New. Authorization callback URL:
   `https://<your-app>/api/auth/github`. Put the pair in `NUXT_OAUTH_GITHUB_CLIENT_ID` /
   `_CLIENT_SECRET`.
2. **Google** — Cloud Console → APIs & Services → Credentials → OAuth client ID. Authorized
   redirect URI: `https://<your-app>/api/auth/google`. Same env var pattern.
3. In production set both as Worker secrets (`wrangler secret put`), not `[vars]`.

---

## Rate limiting

`rateLimit(event, { name, limit, windowSeconds })` — a KV-backed fixed window, auto-imported in
server routes. Applied to the whole `/api/auth/` surface (30/min per IP) and per-user on connect-code
minting (10 per 5 min). Responses carry `X-RateLimit-*`, and a block is a 429 with `Retry-After`.

Two honest caveats, both deliberate:

- **It fails open.** If KV is unreachable the request goes through, logged as
  `rate_limit_unavailable`. An outage in the abuse-control layer must not take sign-in down with it.
- **KV is eventually consistent** and caps sustained writes at roughly one per second per key, so a
  spray from many colos can overshoot for a beat. This is front-door abuse control, not metering.
  Anything you bill on belongs in a Durable Object, which is strongly consistent.

---

## Transactional email

[`server/utils/email.ts`](./server/utils/email.ts) posts to Resend over plain `fetch` — no SDK, for
the same reason the PostHog helper has none. Swapping providers means editing one URL and body.

**It never throws.** Every call site is something more important than the email: a sign-in, or a
Paddle webhook that must return 200 or get retried forever. Unset `NUXT_RESEND_API_KEY` and every
send becomes a logged no-op, so the template runs without a Resend account.

Which emails exist, and when they fire — decided by `decideNotification()` in
[`server/utils/billing-notifications.ts`](./server/utils/billing-notifications.ts), covered by
[`test/billing-notifications.test.ts`](./test/billing-notifications.test.ts):

| Email | Trigger |
| --- | --- |
| Welcome | First sign-in only |
| Subscription/pass active | Transition **into** `active`/`trialing`, or a pass actually granted |
| Payment failed | Transition into `past_due` |
| Access ended | Cancellation, approved refund, or chargeback |

They fire on **status transitions, not events**. Paddle sends a `subscription.updated` for a card
edit or a metadata tweak; emailing on every one teaches people to filter you — and the
payment-failed email is the one that must not end up in a folder.

---

## Billing (Paddle)

Subscription billing is pre-wired for [Paddle](https://www.paddle.com) (merchant of record), sandbox-first. With no Paddle env vars set, all of it no-ops — the template runs fine without a Paddle account.

The pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| Webhook | [`server/routes/paddle/webhook.post.ts`](./server/routes/paddle/webhook.post.ts) | Verifies the `Paddle-Signature` HMAC (see `server/utils/paddle.ts`), then hands the event to `applyPaddleEvent`. Lives outside `/api/` — the signature is the auth. |
| Entitlement writes | [`server/utils/entitlements.ts`](./server/utils/entitlements.ts) | Subscriptions, one-time passes, and refund revocation. Takes the `db` explicitly so [`test/entitlements.test.ts`](./test/entitlements.test.ts) can drive real Paddle events against a real D1. |
| Entitlements | `entitlements` table in [`server/db/schema.ts`](./server/db/schema.ts) | One row per Paddle ref — `sub_…` for subscriptions, `txn_…` for one-time passes — mapped to a user via checkout `custom_data.userId`. |
| Gating | `requireSubscription(event, productKey?)` in [`server/utils/billing.ts`](./server/utils/billing.ts) | Composes on `requireUserSession`; throws 401 signed-out, 402 unsubscribed. Auto-imported in all server routes. |
| Checkout | `usePaddle()` in [`app/composables/usePaddle.ts`](./app/composables/usePaddle.ts) | Lazy-loads Paddle.js, opens overlay checkout with the signed-in user's email and `custom_data.userId`. |
| Status + cancel | `GET /api/billing/entitlement`, `POST /api/billing/portal` | Access status and history for an account page, and a fresh Paddle customer-portal link deep-linked to cancel. The portal route needs `NUXT_PADDLE_API_KEY`. |

What the webhook does with each event:

- `subscription.*` — upsert the row; Paddle's status is the source of truth.
- `transaction.completed` **without** a subscription — a one-time pass: grants `PASS_DAYS` of access, stacking on top of any unexpired access rather than starting from the purchase date. Idempotent across redelivery.
- `adjustment.created` / `adjustment.updated` — money going back out. An **approved** refund or a chargeback revokes the matching entitlement (status `refunded`/`chargeback`, window closed immediately). Credits, chargeback warnings, and reversals never revoke. Refunds arrive as `pending_approval` first, so access survives a refund that gets rejected.

Refunds have no `custom_data`, so they're matched by the transaction/subscription id already on the row — which is why the row stores whichever Paddle ref the purchase came from.

Setup (sandbox):

1. Create a sandbox account at [sandbox-vendors.paddle.com](https://sandbox-vendors.paddle.com), add a product + price.
2. Client token (Developer tools → Authentication) → `NUXT_PUBLIC_PADDLE_CLIENT_TOKEN`, keep `NUXT_PUBLIC_PADDLE_ENV=sandbox`.
3. Notification destination (Developer tools → Notifications) pointing at `https://<your-app>/paddle/webhook`, subscribed to `subscription.*`, `transaction.completed`, `adjustment.created`, and `adjustment.updated`; its secret → `NUXT_PADDLE_WEBHOOK_SECRET` (via `wrangler secret put` in prod, `.env` in dev). **Miss the adjustment events and refunded customers keep their access.**
4. API key (Developer tools → Authentication) → `NUXT_PADDLE_API_KEY`, so `/api/billing/portal` can mint customer-portal links. Without it users can still cancel from their Paddle receipt email, but not from your app.
5. In a page: `const { openCheckout } = usePaddle()` then `openCheckout('pri_…')`. Gate API routes with `await requireSubscription(event)`.

Test the refund path before launch: Paddle → Developer tools → Notifications → Simulate, pick `adjustment.created`, and watch the entitlement flip.

Going live: swap the token/secret for live ones and set `NUXT_PUBLIC_PADDLE_ENV=production`.

---

## Pages

| Route | Access | Notes |
| --- | --- | --- |
| `/` | Public | Landing page — hero, features, CTA. Indexed. |
| `/pricing` | Public | Three plans from `app/utils/plans.ts` + price IDs in runtime config. Indexed. |
| `/login` | Public | OAuth buttons for configured providers + dev sign-in. `noindex`. |
| `/account` | Signed in | Plan status, billing history, self-serve cancel, MCP connect code, sign out. |
| `/dashboard` | Signed in **and** paying | The gated example. Replace with your product. |
| `/terms`, `/privacy` | Public | Templates written to match what this codebase actually does. **Have a lawyer read them.** |
| `/design-system` | Dev only | Stripped from the production route table in `nuxt.config.ts`. |

---

## Design system & brand mark

[`DESIGN.md`](./DESIGN.md) is the source of truth for how this app looks — colour, type, space,
motion, component behaviour, accessibility floors. It is written in the portable
[DESIGN.md](https://designmd.app/) format, so Claude Code, Codex, and Cursor all read it
directly. Two things compile out of it, and neither should ever be hand-edited:

| Command | Reads | Writes |
| --- | --- | --- |
| `/design-sync` | DESIGN.md (colour, type, space, components) | `app/assets/css/main.css`, `app/app.config.ts` |
| `/logo-sync` | DESIGN.md › Brand mark | `app/components/Brand/Logo.vue` |
| `bun run brand:generate` | that component + the colour roles in DESIGN.md | `public/favicon.svg`, `public/apple-touch-icon.png`, `public/og.png`, `brand.lock.json` |

The mark is drawn **once**, in a Vue component, and everything else is cut from it. That is the
whole trick: a favicon, a home-screen icon, and a share image maintained as three separate
files is three chances to redesign one of them and forget the others, and nothing ever fails
when you do. Here the header renders the same `<svg data-brand-mark>` element the icons are
generated from, and `bun run brand:check` — part of `bun run ci` — fails the build when the
generated files stop matching it.

Rasterising uses the Chromium that Playwright already installs for the accessibility suite, so
there is no new dependency and `og.png` is composed in the same engine, with the same webfonts,
that renders the site. It needs a network connection for those fonts; offline it still produces
correct assets and tells you it fell back.

Two gates keep app code inside the system: `bun run design:check` fails on anything that
bypasses the token layer (a numbered colour scale, a raw hex, a suppressed focus ring), and
`bun run test:a11y` runs axe in a real browser over every public route in both colour modes.
The dev-only `/design-system` route renders every token, component state, and generated brand
asset on one page — that is where you verify a change actually landed.

Forking? Replace everything below the Identity heading in `DESIGN.md` (or drop in one from
[designmd.app](https://designmd.app/)), run `/design-sync`, then `/logo-sync`. A fork that would
rather hand-author its icons can drop `brand:check` from the `ci` script.

---

## SEO & AEO

Classic SEO is about being **findable**. Answer engines — AI Overviews, ChatGPT Search,
Perplexity — are about being **quotable**: they need to extract, without guessing, what the
product is, who runs it, what it costs. Prose gets paraphrased wrongly; a typed graph doesn't.
Both halves are wired here, and both are enforced by CI.

### One call per page

Every page calls [`useSeo()`](./app/composables/useSeo.ts) exactly once. It emits the four
things that have to happen together, three of which are easy to forget:

| | Why it's in the wrapper |
| --- | --- |
| `<link rel="canonical">` | `useSeoMeta()` does **not** emit one. On Workers the same app answers on `*.workers.dev` *and* your custom domain — without a canonical you publish two spellings of every page and split the ranking. |
| Open Graph + Twitter | With an **absolute** `og:image`. Relative ones are dropped by most unfurlers, so a share renders as bare text. |
| JSON-LD | The `@graph` an answer engine actually reads — see below. |
| `noindex` | Per-page, plus globally on preview deploys. |

```ts
useSeo({
  title: 'Pricing',                        // `· My App` is appended for you
  description: 'Plans and pricing …',
  breadcrumb: [{ name: 'Pricing', path: '/pricing' }],
  schema: [softwareApplicationSchema(site, { … }), faqSchema(PRICING_FAQ)],
})
```

### Public pages declare themselves

```ts
definePageMeta({
  publicPage: { changefreq: 'weekly', priority: '0.8', title: 'Pricing', summary: '…' },
})
```

That single declaration is what puts a page in **both** `sitemap.xml` and `llms.txt`. There is
no list to keep in sync — the previous version of this template had a hardcoded array in the
sitemap route, and a hardcoded array is a second place to remember. Add `/changelog`, ship it,
and it was simply never in the sitemap, with nothing failing.

A page without the key is in neither, which is the right default: most pages added to an app
are private. Dynamic routes (`/posts/[id]`) are one pattern, not N URLs — query D1 for those in
[`sitemap.xml.get.ts`](./server/routes/sitemap.xml.get.ts).

`<lastmod>` is the **build date**, not the request date. `new Date()` at request time tells
crawlers every page changed today, on every fetch, and they discount a lastmod that always
says "now".

### Structured data

Builders live in [`shared/utils/schema.ts`](./shared/utils/schema.ts) as pure functions, so
their shapes are unit-testable without booting Nuxt. Nodes are linked by `@id` rather than
duplicated — one `Organization`, one `WebSite`, everything else pointing at them — which is
what lets a consumer resolve "this page" and "this company" to single entities.

`/` and `/pricing` carry `SoftwareApplication` with a real `AggregateOffer`; `/pricing` adds
`FAQPage`. Two rules worth keeping:

- **Never describe something in JSON-LD that isn't on the page.** The pricing FAQ is rendered
  from the same [`PRICING_FAQ`](./app/utils/faq.ts) array that feeds the markup, so the two
  cannot disagree. FAQ markup without a visible FAQ is a manual-action risk with Google.
- **Prices are numbers, not display strings.** `app/utils/plans.ts` carries `amount`,
  `currency`, and `unit` next to the `'$12'` copy, because parsing a currency glyph out of
  display text breaks the first time someone writes `'From $12'` — and a wrong price published
  to answer engines is a bad failure to have.

### The three crawler files

All generated at [`server/routes/`](./server/routes/) rather than dropped in `public/`, so they
can use the real deployment origin:

- **`robots.txt`** — names every AI crawler explicitly (GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended, …) instead of leaving them to `User-agent: *`. Not because the default is
  wrong, but because a policy you can read is a policy you can change. Defaults to allowing
  them: for a SaaS marketing site, being quotable is distribution, not theft. Flip with
  `NUXT_PUBLIC_ALLOW_AI_CRAWLERS=false`.
- **`sitemap.xml`** — derived from the route table, as above.
- **`llms.txt`** — the [llmstxt.org](https://llmstxt.org) convention: a short Markdown map of
  the site for a model with limited context and no patience for navigation. A map, not a
  mirror — every line is a link plus one sentence, built from the same `publicPage`
  declarations, so it can't drift.

Set `NUXT_PUBLIC_INDEXABLE=false` on preview deploys: robots.txt disallows everything, every
page renders `noindex`, sitemap.xml goes empty and llms.txt 404s. An indexed preview URL
competes with production for the same content.

### The gate

```bash
bun run seo:check
```

Part of `bun run ci`. The SEO layer is only a contract if something enforces it, and its
failure mode is the worst kind: nothing throws, the page renders, and you find out from a
traffic graph months later. The gate fails the build on a page that skips `useSeo()`, calls
`useSeoMeta()`/`useHead()` behind its back, is indexable but undeclared (or `noindex` *and*
declared), has a missing or badly-sized description, or has more than one `<h1>`. Escape hatch
is `seo-check-ignore`, same as the design-token gate.

`public/og.png` is generated, not hand-made: `bun run brand:generate` composes it from the brand
mark, the DESIGN.md colours, and the app name in `wrangler.toml`. So the fix for a share image
that still says "My App" is to rename the project and re-run that command — and `bun run
brand:check` fails the build until you do. See [Design system & brand mark](#design-system--brand-mark).

The legal pages are the part people skip and then get stuck on: Paddle's onboarding review checks
for reachable terms and privacy pages before approving an account. The ones here name the actual
processors this template ships with (Cloudflare, Paddle, PostHog, Resend) and describe the real
refund behaviour. They are still a starting point, not legal advice, and each carries a banner
saying so until you remove it.

---

## Feedback loop

PostHog (wired in [`app/plugins/posthog.client.ts`](./app/plugins/posthog.client.ts)) tells you what users **did** — autocapture, session replay, exceptions, heatmaps, dead clicks, web vitals, all proxied same-origin through `/ingest` so ad blockers can't drop it. Empty `NUXT_PUBLIC_POSTHOG_KEY` = the whole thing no-ops.

This section is the other half: what users **said**.

### The widget

`<FeedbackWidget />` is mounted once in [`app/layouts/default.vue`](./app/layouts/default.vue), so every page has a floating trigger. Drop `<FeedbackWidget position="inline" />` into a page instead (end of onboarding, account page, cancellation flow) if a floating button doesn't suit the product.

It's open to **signed-out visitors on purpose** — requiring a login before someone can tell you something is the fastest way to hear nothing. `POST /api/feedback` is the one method+path the global auth middleware allowlists; reading and triaging stay gated.

### What one submission produces

1. **A row in the `feedback` table (D1)** — yours forever, joinable against `users` and `entitlements`, and it survives dropping PostHog. Carries the kind, message, route, optional reply-to email, optional 1–5 rating, and a deep link to the PostHog session replay of that exact moment.
2. **A PostHog `feedback_submitted` event** on the submitter's distinct id, so the note lands on their person timeline next to the replay. Capture is **server-side only** — the client passes the replay URL and distinct id but never captures, so a blocked SDK can't lose the event and it can't be double-counted.

Abuse control: 5 submissions per hour per source, counted against a salted SHA-256 of the IP (`ip_hash`) — enough to rate-limit, useless as an identifier.

### Reading the queue

- `GET /api/feedback?status=new&limit=50` — admin-only list. Admin means `users.role = 'admin'` in D1 (`requireAdmin()` in [`server/utils/admin.ts`](./server/utils/admin.ts)), not a session claim — grant it with `UPDATE users SET role = 'admin' WHERE email = '…';`
- `PATCH /api/feedback/<id>` — mark `triaged`/`closed` and link the GitHub issue it became.
- The [`feedback-triage`](./.claude/routines/feedback-triage.md) routine (ships disabled, like all routines) reads new rows daily over `wrangler d1 execute --remote`, files bugs and ideas as labelled GitHub issues, and escalates anything angry, legal, or security-shaped instead of publishing it. Feedback text is untrusted input — the routine is instructed accordingly.

### Asking, not just listening

The widget is for **unsolicited** feedback. For **solicited** feedback — NPS, CSAT, "why did you cancel?" — use PostHog Surveys: create one in the PostHog dashboard and it just works, because `posthog-js` fetches survey config and `surveys.js` through the same `/ingest` proxy. No code change, no deploy.

For prompts you want to own end-to-end, call the composable directly and the answer lands in your own table:

```ts
const { submit } = useFeedback()
await submit({ kind: 'other', message: reason, rating: 2 })
```

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
