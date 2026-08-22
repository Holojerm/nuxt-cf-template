# Agent tooling — MCP servers, skills, commands, routines

What ships in `.mcp.json` and `.claude/`: the MCP servers available for live introspection, the NuxtUI skill, the slash commands, and the cloud operations routines that run the commercial side of a fork.

> **Load this when:** configuring Claude Code for this repo, wiring a new MCP server, or setting up the operations routines after a fork.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

This project ships with Claude Code configuration in `.mcp.json` and `.claude/`. All forks inherit this setup automatically.

## MCP Servers (`.mcp.json`)

| Server | Type | Purpose |
| --- | --- | --- |
| `cloudflare-docs` | Remote HTTP | Workers, D1, KV, R2, Pages documentation — always active |
| `cloudflare-bindings` | Remote HTTP | Workers bindings and API reference — always active |
| `nuxt-ui` | Remote HTTP | NuxtUI v4 component API docs, composables, templates, migration guide — always active |
| `github` | Remote HTTP | GitHub repo/PR/issue context — requires `GITHUB_TOKEN` env var |
| `nuxt` | Local SSE | Live project introspection (pages, components, auto-imports, config) — requires `bun dev` |
| `drizzle` | Local stdio | Schema introspection against `server/db/schema.ts` |

**Setup notes:**
- `cloudflare-*` and `nuxt-ui` work with no credentials — always available.
- For GitHub MCP: set `GITHUB_TOKEN` in your shell (a PAT with repo read scope is enough).
- For live Nuxt introspection: start `bun dev` before opening Claude Code. The `nuxt` server URL in `.mcp.json` is `https://<portless-name>.localhost/__mcp/sse` and must match the `portless.name` in `package.json`. Rename both when you fork.
- **In a linked worktree the dev host is different**, so that committed URL is wrong there by design — see the worktree section below. `bun dev` prints the host it's using, and `nuxt-mcp` repoints `.mcp.json` at it on boot so introspection keeps working. That leaves a modified `.mcp.json` in the worktree: expected, and **not something to commit**.
- Drizzle MCP works automatically via `bunx`.

## NuxtUI Skill (`.claude/skills/nuxt-ui/`)

Installed via `npx skills add nuxt/ui --agent claude-code`. Provides Claude with deep knowledge of NuxtUI's component patterns, theming system, and composables. Complements the `nuxt-ui` MCP server (which provides live API lookups).

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

## Operations Routines (`.claude/routines/`)

Repo-shipped definitions for cloud agents that run the commercial side of a fork semi-autonomously:
GitHub issue triage, bug-fix PRs, in-app feedback triage, support-inbox drafting, weekly
analytics review, marketing drafts, and a single daily digest email to the owner. **All ship default-inactive** — `/routines
sync` registers them (disabled) in your claude.ai account, and each one is enabled explicitly.
Routines coordinate through an `ops-journal` branch (never merged to `main`, so journal commits
don't trigger deploys). When forking: fill in `.claude/routines/routines.config.md`, connect
GitHub + Gmail at claude.ai/customize/connectors, then `/routines sync`. Full docs in
[.claude/routines/README.md](../routines/README.md).

---


