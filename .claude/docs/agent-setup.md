# Agent tooling — MCP servers, skills, commands, routines

What ships in `.mcp.json.example` and `.claude/`: the MCP servers available for live introspection, the NuxtUI skill, the slash commands, and the cloud operations routines that run the commercial side of a fork.

> **Load this when:** configuring Claude Code for this repo, wiring a new MCP server, or setting up the operations routines after a fork.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

This project ships with Claude Code configuration in `.mcp.json.example` and `.claude/`. All forks inherit this setup automatically. The live `.mcp.json` is gitignored: `bun dev` creates it from the example on first run, and `nuxt-mcp` keeps rewriting it after that, so it is never committed.

## MCP Servers (`.mcp.json.example`)

| Server | Type | Purpose |
| --- | --- | --- |
| `cloudflare-docs` | Remote HTTP | Workers, D1, KV, R2, Pages documentation — always active |
| `cloudflare` | Remote HTTP | The whole Cloudflare API through `search` + `execute` — OAuth sign-in on first use |
| `nuxt-ui` | Remote HTTP | NuxtUI v4 component API docs, composables, templates, migration guide — always active |
| `github` | Remote HTTP | GitHub repo/PR/issue context — requires `GITHUB_TOKEN` env var |
| `nuxt` | Local SSE | Live project introspection (pages, components, auto-imports, config) — requires `bun dev` |
| `drizzle` | Local stdio | Schema introspection against `server/db/schema.ts` |

**Setup notes:**
- `cloudflare-docs` and `nuxt-ui` work with no credentials — always available.
- For GitHub MCP: set `GITHUB_TOKEN` in your shell (a PAT with repo read scope is enough).
- For live Nuxt introspection: start `bun dev` before opening Claude Code. The `nuxt` server URL in the MCP config is `https://<portless-name>.localhost/__mcp/sse` and must match the `portless.name` in `package.json`. Rename both when you fork.
- **In a linked worktree the dev host is different**, so that committed URL is wrong there by design — see the worktree section below. `bun dev` prints the host it's using, and `nuxt-mcp` repoints the local MCP config at it on boot so introspection keeps working. The file is gitignored, so there is nothing to commit.
- Drizzle MCP works automatically via `bunx`.

## Skills (`.claude/skills/`)

Every skill here is listed in every session, and `AGENTS.md` › Agent tooling names the moment each one is loaded. A skill nobody is told to load never runs, so a new one comes with its row there. `docs/skills-audit.md` records why each was kept and how to re-measure use.

Each is a plain copy pinned in `skills-lock.json` (source, commit, hash) and reaches forks with the rest of the template. Refresh with `bunx skills update -p -y`; add with `bunx skills add <owner/repo> --skill <name> --agent claude-code -y`, then review the diff like a dependency bump.

| Skill | Source | Purpose |
| --- | --- | --- |
| `nuxt-ui` | nuxt/ui | NuxtUI v4 components, theming, forms, layouts. Complements the `nuxt-ui` MCP server (live API lookups) |
| `frontend-design` | anthropics/skills | Visual direction for a new page or a redesign, inside `DESIGN.md` |
| `web-design-guidelines` | vercel-labs/agent-skills | Reviews changed UI files against a pinned copy of the Web Interface Guidelines |
| `design-qa-checklist` | Owl-Listener/designer-skills | Every state, touch target and edge case checked before UI work is called done |
| `state-machine` | Owl-Listener/designer-skills | Enumerates a flow's states so none is impossible or a dead end |
| `loading-states` | Owl-Listener/designer-skills | Waiting by duration tier, no layout shift, optimistic updates with rollback |
| `error-handling-ux` | Owl-Listener/designer-skills | Error placement by context, preserved input, what/why/what-next messages |
| `feedback-patterns` | Owl-Listener/designer-skills | Confirmations and toasts: where, how long, undo over "are you sure" |
| `ux-writing` | Owl-Listener/designer-skills | Labels, errors, empty states, CTAs (voice comes from `DESIGN.md`) |
| `a-b-test-design` | Owl-Listener/designer-skills | Hypothesis, one primary metric plus guardrails, sample size, when not to test |
| `copywriting` | coreyhaines31/marketingskills | Landing and marketing copy whose every claim can be backed |
| `seo-audit` | coreyhaines31/marketingskills | Technical and on-page SEO audit beyond `bun run seo:check` |
| `workers-best-practices` | cloudflare/skills | Workers code and config rules, for sessions without the Cloudflare plugin |
| `systematic-debugging` | obra/superpowers | Root cause before any fix |

Licences and copyright lines for every source are in `.claude/skills/THIRD_PARTY_NOTICES.md`; add a row there with any new skill.

## Slash Commands (`.claude/commands/`)

| Command | Usage | Purpose |
| --- | --- | --- |
| `/scaffold-component` | `/scaffold-component Feature/Name` | Generate a Vue component following project conventions |
| `/design-sync` | `/design-sync [brief\|url]` | Compile `DESIGN.md` into the NuxtUI token layer, then verify |
| `/logo-sync` | `/logo-sync [brief\|path.svg]` | Design the brand mark from `DESIGN.md`, then generate every icon from it |
| `/scaffold-api` | `/scaffold-api [path] [method]` | Generate an API route with Zod + auth |
| `/db-migrate` | `/db-migrate` | Run the full Drizzle migration workflow |
| `/new-feature` | `/new-feature FeatureName` | Full stack scaffold: component + API routes + schema |
| `/routines` | `/routines sync\|status\|enable\|disable\|run` | Manage the cloud operations routines defined in `.claude/routines/` |
| `/mcp-publish` | `/mcp-publish [check\|registry\|claude\|chatgpt]` | List the app's own MCP server (`mcp/`) in the MCP Registry, Claude's directory and ChatGPT's — see [mcp.md](mcp.md) |

## Operations Routines (`.claude/routines/`)

Repo-shipped definitions for cloud agents that run the commercial side of a fork semi-autonomously:
GitHub issue triage, bug-fix PRs, roadmap-item builds that fleet picks, in-app feedback triage, support-inbox drafting, weekly
analytics review, marketing drafts, and a single daily digest email to the owner. **All ship default-inactive** — `/routines
sync` registers them (disabled) in your claude.ai account, and each one is enabled explicitly.
Routines coordinate through an `ops-journal` branch (never merged to `main`, so journal commits
don't trigger deploys). When forking: fill in `.claude/routines/routines.config.md`, connect
GitHub + Gmail at claude.ai/customize/connectors, add the D1 read token to the cloud
environment, then `/routines sync`. Full docs in [.claude/routines/README.md](../routines/README.md).

---


