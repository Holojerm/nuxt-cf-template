---
schedule: "0 14 * * 3"
model: claude-sonnet-5
connectors: [github]
tier: 2
enabled: false
---

# Template Sync

## Purpose

Every fork drifts behind `nuxt-cf-template`. The fleet dashboard reports it as
`template_behind`, but nothing catches it up, and the longer a sync waits, the harder it is.
Once a week, in a fork, open the sync PR the owner would otherwise have to remember. With a
tier-2 grant the PR merges itself through the merge queue once its checks pass. Without one it
is a draft the owner readies.

## Instructions

1. Read `fleet.json` › `template`. If it has no `repo`, this checkout is the template itself:
   journal `- no action needed (this is the template)` and stop.
2. `git fetch origin`, then clone or fetch the template (`https://github.com/<template.repo>`,
   public) and read its default branch head. Count the template commits since
   `template.syncedSha`. If that count is 0, journal a no-op and stop.
3. If a PR from `chore/template-sync` is already open, check its base. If it is behind the
   default branch, rebase it and re-run `bun run ci`. Then comment the new template commits it
   does not include yet, and stop. One sync PR at a time.
4. Otherwise, follow `.claude/commands/sync-forks.md` for **this fork only**. Its rules are
   the same here:
   - work on `chore/template-sync` off the fetched default branch;
   - tailor rather than bulk-copy;
   - never copy a migration file;
   - never overwrite an `app-owned.json` path;
   - port into `template.customized` paths by hand, or say why not;
   - set `template.syncedSha` to the template commit you actually synced to.
5. `bun install --frozen-lockfile && bun run ci` must pass. Open the PR with the sections
   `sync-forks.md` asks for: what was broken and what it cost, what came over, what was
   deliberately left out and why, and how it was verified. Label it `template-sync`.
6. If the sync needs a product decision (pricing, gating, legal copy, an auth model that does
   not fit), skip that piece, keep the rest of the sync, and say so in the PR under
   `needs-owner`.
7. **Ready or draft.** Open the PR ready for review, so the merge queue lands it when green,
   only when all of these hold. Otherwise open it as a draft, label it `needs-owner`, and say
   which one failed.
   - `routines.config.md` › Autonomy grants lists `template-sync` at tier 2.
   - `bun run ci` passed here.
   - The sync touches nothing the tier-2 "never" column names (pricing, billing, auth, data
     deletion) and adds no migration.
   - Step 6 skipped nothing: a piece left for the owner means the owner reads the PR.
8. Journal the PR link, the template range synced, and anything left out.

## Hard limits for this routine

- Never merge directly, never use `--admin`, and never enable GitHub auto-merge. A ready PR
  is the only way this routine ships: the queue merges it.
- One PR per run, on `chore/template-sync` only.
