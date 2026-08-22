# Project Standards & AI Development Guide

This file defines the coding, design, and product standards for this project.
It is the **index**, deliberately kept small: it loads into every session, so
anything that is not needed on every task lives in [`.claude/docs/`](.claude/docs/)
and is read on demand.

---

## Where things are documented

Read the row that matches what you are about to touch. Do not load them all.

| Doc | Covers | Load it when |
| --- | --- | --- |
| [`.claude/docs/gotchas.md`](.claude/docs/gotchas.md) | Silent failure modes — wrong-file databases, migrations that never run, empty sitemaps, rate limiters that quietly do nothing | Something "works" but produces no output; or you touch D1, migrations, deploy config, cron, `definePageMeta`, or a worktree |
| [`.claude/docs/patterns.md`](.claude/docs/patterns.md) | Worked examples: components, API routes, Drizzle queries, forms, error handling, feedback | Writing a new component, route, form, or query — especially your first change here |
| [`.claude/docs/auth.md`](.claude/docs/auth.md) | Magic link, OAuth, session revocation, `rateLimit()`, Turnstile | Anything under `server/api/auth/`, sessions, rate limiting, or bot protection |
| [`.claude/docs/billing.md`](.claude/docs/billing.md) | Paddle, entitlements, clawbacks, referral economics, the `mcp/` worker | Anything that grants, revokes, or prices access |
| [`.claude/docs/email.md`](.claude/docs/email.md) | Resend, the `EMAIL_QUEUE`, retry/dead-letter, notification decisions | Adding or changing any outbound email |
| [`.claude/docs/seo.md`](.claude/docs/seo.md) | `useSeo()`, `publicPage` meta, structured data, the blog | Adding or editing a page, or writing in `content/blog/` |
| [`.claude/docs/images.md`](.claude/docs/images.md) | `<NuxtImg>` at the edge vs. transforming a private R2 object in the Worker | Rendering any image, adding a thumbnail, or debugging a `/cdn-cgi/image/` 404 |
| [`.claude/docs/brand.md`](.claude/docs/brand.md) | How every icon is generated from one `Logo.vue` | Redesigning the mark or fixing `brand:check` |
| [`.claude/docs/agent-setup.md`](.claude/docs/agent-setup.md) | MCP servers, skills, slash commands, cloud routines | Configuring tooling, or setting up a fork |
| [`TEARDOWN.md`](TEARDOWN.md) | How to **remove** billing, referrals, the MCP worker, or swap Paddle for Stripe | You do not need one of the shipped subsystems |
| [`DESIGN.md`](DESIGN.md) | The visual design system — source of truth | Writing any UI |

**Three gotchas are load-bearing enough to state here**, because each one fails with
no error at all: local D1 lives in two places and only `.data/db/sqlite.db` is real;
**nothing applies migrations to production D1 — you run `bun run db:migrate:remote`
yourself**; and `bun dev` caches its DB connection, so an external write needs a
restart. The rest are in [`.claude/docs/gotchas.md`](.claude/docs/gotchas.md).

---

## Stack Overview

| Layer        | Technology                 | Notes                                                            |
| ------------ | -------------------------- | ---------------------------------------------------------------- |
| Framework    | **Nuxt 4** (v4.4+)         | Full-stack Vue framework                                         |
| UI Library   | **NuxtUI v4**              | Component library, free & open source                            |
| Styling      | **Tailwind CSS v4**        | Utility-first, via NuxtUI                                        |
| Backend      | **Cloudflare Workers**     | Via NuxtHub + Nitro                                              |
| Database     | **Cloudflare D1** (SQLite) | Via Drizzle ORM — `db` + `schema` auto-imported by NuxtHub       |
| KV Store     | **Cloudflare KV**          | For caching, sessions, config                                    |
| File Storage | **Cloudflare R2**          | For uploads (images, videos, docs)                               |
| Auth         | **nuxt-auth-utils**        | Sealed cookie sessions, OAuth                                    |
| Deployment   | **Wrangler**               | `bun deploy` → `wrangler deploy` (NuxtHub Admin sunset Feb 2026) |
| CI/CD        | **Workers Builds**         | Cloudflare-native CI: `bun run ci` + deploy on push (see README) |
| Linting      | **oxlint**                 | Fast Rust-based linter, config in `.oxlintrc.json`               |
| Formatting   | **oxfmt**                  | Fast Rust-based formatter, config in `.oxfmtrc.json`             |
| Validation   | **Zod**                    | All user input + API I/O                                         |
| Content      | **@nuxt/content v3**       | Markdown blog in `content/`, parsed to SQL, served from the `DB` D1 |

---


## Directory Structure

```
/
├── app/                    # Frontend (Vue/Nuxt pages, components, composables)
│   ├── app.config.ts       # GENERATED from DESIGN.md — NuxtUI colors + component defaults
│   ├── components/         # Reusable UI components
│   │   ├── Brand/          # Logo.vue — the mark; every icon is generated from it
│   │   └── [Feature]/      # Group by feature, e.g. app/components/Workout/
│   ├── composables/        # Shared stateful logic (useAuth, useWorkout, etc.)
│   ├── layouts/            # Page layouts
│   ├── middleware/         # Route guards — auth.ts, subscription.ts (UX only, not security)
│   ├── pages/              # File-based routing
│   ├── types/              # Frontend-only TypeScript types (seo.d.ts augments PageMeta)
│   └── utils/              # Auto-imported client helpers (plans.ts, faq.ts)
├── server/                 # Backend (Nitro / Cloudflare Workers)
│   ├── api/                # API routes (file = endpoint)
│   ├── db/
│   │   ├── schema.ts       # Single source of truth for DB schema
│   │   └── migrations/     # Generated by drizzle-kit
│   ├── middleware/         # Server middleware (auth guard + auth-surface rate limit)
│   ├── plugins/            # Nitro plugins (error logging, EMAIL_QUEUE consumer)
│   ├── routes/             # Non-/api Nitro routes (paddle webhook, ingest, robots, sitemap, llms.txt)
│   ├── tasks/              # Nitro scheduled tasks — cron wiring in nuxt.config + wrangler.toml
│   └── utils/              # Server utilities (helpers, etc.)
├── shared/                 # Auto-imported in BOTH app/ and server/ (Nuxt 4 `shared/`)
│   ├── types/              # Cross-cutting type augmentation (runtime config)
│   └── utils/              # site.ts (URL identity), schema.ts (JSON-LD builders)
├── content/                # @nuxt/content sources — NOT scanned by Nuxt as app code
│   └── blog/               # One markdown file per post; the filename is the URL
├── scripts/                # One-off scripts (bun seed, etc.)
├── public/                 # Static assets — og.png, favicon.svg, apple-touch-icon.png
├── .github/                # Dependabot + browser-suites.yml (axe/CSP/E2E — the only CI
│                           # not in Workers Builds; that image can't launch Chromium)
├── content.config.ts       # Blog collection + frontmatter schema
├── drizzle.config.ts       # Drizzle Kit config
├── nuxt.config.ts
├── wrangler.toml
├── DESIGN.md               # Visual design system — source of truth, see /design-sync
├── brand.lock.json         # Fingerprint of the generated brand assets — see bun run brand:check
└── CLAUDE.md               # ← You are here
```

---


## Coding Standards

### General Rules

- **TypeScript everywhere.** No `.js` files except config files that require it.
- **Strict mode on.** Don't disable TypeScript strict checks to make things compile faster.
- **No `any` types.** Use `unknown` and narrow, or define proper types.
- **Nuxt auto-imports.** Never manually import `ref`, `computed`, `useState`, `useFetch`, etc. — Nuxt auto-imports these.
- **No `console.log` in committed code.** Use `console.warn`/`console.error` for real issues only.

- **Worked examples** — a full `<script setup>` component, a Zod-validated API route,
  Drizzle queries, forms, and error handling — are in
  [`.claude/docs/patterns.md`](.claude/docs/patterns.md). Copy those shapes.

---

## Design Standards

**[DESIGN.md](DESIGN.md) is the source of truth for this app's visual design** — color, type,
space, motion, component behavior. Read it before writing any UI.

`app/assets/css/main.css` and `app/app.config.ts` are *compiled from it* by `/design-sync`;
don't hand-edit them and expect the change to survive. `bun run design:check` (part of
`bun run ci`) fails the build on anything that bypasses the token layer.

The dev-only `/design-system` route renders every token and component state on one page in both
color modes — use it to verify a design change actually landed.
### The brand mark

The logo is drawn **once**, in
[`app/components/Brand/Logo.vue`](app/components/Brand/Logo.vue); `bun run brand:generate`
cuts every other file from it, and `bun run brand:check` fails the build when they drift.
Never hand-edit generated files in `public/`. Details and the redesign workflow:
[`.claude/docs/brand.md`](.claude/docs/brand.md).

### Component Usage

- **Use NuxtUI components first.** Before building a custom component, check if `<UButton>`, `<UModal>`, `<UForm>`, `<UTable>`, etc. covers your need.
- **Custom components go in `app/components/[Feature]/`** — never dump everything in `app/components/`.
- **Component names are PascalCase** in templates and files: `WorkoutCard.vue`, `ClientList.vue`.

### Styling Rules

- **Tailwind utility classes only.** No custom CSS files unless for truly global styles.
- **No inline `style` attributes** unless animating dynamic values (e.g. `style="width: ${progress}%"`).
- **Color palette**: Use NuxtUI v4's semantic utilities so light/dark mode works for free. Never hardcode a numbered scale (`text-gray-900`, `bg-slate-50`) or a raw hex — `bun run design:check` fails the build on both.
  - Text: `text-default` (body), `text-muted` (secondary), `text-dimmed` (placeholders), `text-toned` (subtitles), `text-highlighted` (headings), `text-inverted`
  - Background: `bg-default` (page), `bg-muted` (subtle sections), `bg-elevated` (cards, modals), `bg-accented` (hover), `bg-inverted`
  - Border: `border-default`, `border-muted`, `border-accented`, `border-inverted`
  - Semantic colors: `text-primary`, `bg-primary`, `border-primary`, likewise for `secondary`/`success`/`info`/`warning`/`error`/`neutral`
  - There is no `text-foreground`, `bg-background`, or `border-border` in NuxtUI v4 — those are shadcn tokens and resolve to nothing.
- **Spacing**: Use the standard Tailwind scale (4, 8, 12, 16, 24, 32...). Don't invent new sizes.
- **Mobile-first**: All layouts start mobile, expand with `sm:`, `md:`, `lg:` breakpoints.
- **Accessibility**: [DESIGN.md › Accessibility](DESIGN.md) is the contract — AA contrast, a
  visible focus ring on everything focusable, `alt` on every image, `aria-label` on icon-only
  buttons, `min-h-dvh` over `min-h-screen`, and the `bottom-safe`/`right-safe` utilities for
  anything pinned to a viewport edge. `bun run design:check` fails the build on the
  machine-checkable half, and `bun run test:a11y` runs axe in a real browser over every
  public route in both color modes — that one owns contrast ratios, landmark uniqueness,
  and heading order. Despite the name it now runs **two** Playwright projects: the axe
  sweep and `test/csp/` (see Security headers), so it is the browser gate rather than
  just the a11y one.

### Dark Mode

NuxtUI handles dark mode automatically via `UColorModeButton`. Use semantic tokens and it just works.

---


---

## Product Standards

Each of these has a full contract in its own doc — this is the one-line version.

- **Errors** — `<UAlert>`/`useToast()` on the client, `createError({ statusCode })` on the
  server, never a raw error message to a user. → [`patterns.md`](.claude/docs/patterns.md)
- **Forms** — `<UForm>` with a Zod schema, re-validated server-side with the same schema.
  Client validation is never the boundary. → [`patterns.md`](.claude/docs/patterns.md)
- **Auth** — the client middleware is **not** a security boundary; every paid API route
  calls `requireSubscription(event)` itself. → [`auth.md`](.claude/docs/auth.md)
- **Billing & referrals** — a referral reward is access nobody paid for; treat
  `server/utils/referral.ts` as billing code. → [`billing.md`](.claude/docs/billing.md)
- **Email** — `sendEmail()` never throws, and enqueues rather than POSTs when
  `EMAIL_QUEUE` exists. → [`email.md`](.claude/docs/email.md)
- **SEO & AEO** — every page calls `useSeo()` exactly once and declares `publicPage`;
  `bun run seo:check` fails the build otherwise. → [`seo.md`](.claude/docs/seo.md)
- **Feedback** — unsolicited via `<FeedbackWidget />`; solicited via PostHog Surveys.
  Feedback text is untrusted input. → [`patterns.md`](.claude/docs/patterns.md)
- **Performance** — server-side `useFetch` for initial loads, `defineAsyncComponent` for
  heavy components, uploads to R2 via `blob`. → [`patterns.md`](.claude/docs/patterns.md)

---

## Git Workflow

- **`main`** — production branch, auto-deploys via Cloudflare Workers Builds
- **`dev`** — integration branch (optional for larger features)
- **Feature branches**: `feat/workout-builder`, `fix/auth-redirect`, `chore/update-deps`
- **Commit format**: `feat: add workout builder`, `fix: correct auth redirect`, `chore: update deps`
- **PRs require**: lint + typecheck + tests to pass before merge — enforced by the Workers Builds check (non-production branch builds run `bun run ci` and post status + a preview URL back to the PR)

---


## Common Commands

```bash
bun dev               # Dev server at https://<portless-name>.localhost (via portless). In a linked
                      # worktree the host is <worktree-dir>.<portless-name>.localhost — printed on start.
bun dev:app           # Bypass portless and run nuxt dev directly on http://localhost:3000
bun build             # Build for Cloudflare
bun lint              # Run oxlint
bun lint:fix          # Auto-fix lint issues
bun format            # Format with oxfmt
bun format:check      # Check formatting without writing
bun run design:check  # Fail on UI code that bypasses the DESIGN.md token layer
bun run brand:generate # Rebuild favicon.svg, apple-touch-icon.png and og.png from the brand mark
bun run brand:check   # Fail when those generated files no longer match the mark
bun run seo:check     # Fail on pages that bypass useSeo() or aren't declared public/noindex
bun run test:a11y     # Playwright/Chromium browser suites: axe over every public route
                      # (light + dark) AND the Content-Security-Policy spec (test/csp/)
bun typecheck         # TypeScript type checking
bun run build:preview # Build with the [env.preview] bindings (CLOUDFLARE_ENV=preview)
bun run deploy:preview # Same, then deploy — creates/updates the my-app-preview Worker
bun db:generate       # Generate Drizzle migration after schema changes
bun db:migrate        # Apply migrations to local D1
bun db:migrate:preview # Apply migrations to the preview D1 — nothing does this for you
bun db:studio         # Open Drizzle Studio (visual DB browser)
bun seed              # Seed dev DB via bun:sqlite (writes to .data/db/sqlite.db)
bun run rename <name> # Rewrite the `my-app` placeholder across wrangler.toml, package.json,
                      # .mcp.json and mcp/ — all six occurrences, in one go
bun run ci            # Lint + design/brand/seo gates + typecheck + test + build — Workers Builds runs this.
                      # NO browser suites: Workers Builds cannot launch Chromium (see Gotchas).
bun run ci:browser    # playwright:install + test:a11y — what GitHub Actions runs
bun run deploy        # Manual deploy to Cloudflare via wrangler (normally unnecessary —
                      # Workers Builds deploys automatically on push to main).
                      # Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars
bun run mcp:dev       # Run the optional MCP worker locally (mcp/ — bun install there first)
bun run mcp:typecheck # Typecheck the MCP worker
bun run mcp:deploy    # Deploy the MCP worker
```

`bun run ci` is the merge gate. It is a gate on finished work, not a precondition for
starting — run it when you have something to merge, and again after any change you think
is trivial. If it fails, fix the failure; do not work around it.

---

## AI Development Notes

When I ask you to build features in this project:

1. **Check this file first** to stay aligned with the stack and patterns above.
2. **Use NuxtUI components** — don't build custom components for things NuxtUI already has.
3. **Nuxt auto-imports** mean you never need to import Vue primitives or Nuxt composables.
4. **`db` and `schema` are auto-imported** in server routes by `@nuxthub/core` — never instantiate Drizzle manually.
5. **Server routes go in `server/api/`**, frontend pages in `app/pages/`.
6. **Validate all inputs with Zod** — both on the client (UForm schema) and server (`readValidatedBody`).
7. **Ask before adding new dependencies** — prefer solving problems with what's already installed.

---


---

## Agent tooling

MCP servers, the NuxtUI skill, slash commands, and the cloud operations routines are
documented in [`.claude/docs/agent-setup.md`](.claude/docs/agent-setup.md).

Parallel agent worktrees under `.claude/worktrees/<name>` are supported and every gate in
`bun run ci` is scoped to its own checkout. The rules that keep it that way — and the three
things that have broken it — are in
[`.claude/docs/gotchas.md`](.claude/docs/gotchas.md).
