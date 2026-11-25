---
schedule: "0 14 * * 3"
model: opus
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
   - a fork's own routine definitions name a model tier (`model: opus`, `sonnet` or `haiku`),
     not an ID, like the template's: convert any that pin one, or `bun run routines:check` fails;
   - set `template.syncedSha` to the template commit you actually synced to.
5. `bun install --frozen-lockfile && bun run ci` must pass. Open the PR with the sections
   `sync-forks.md` asks for: what was broken and what it cost, what came over, what was
   deliberately left out and why, and how it was verified. Label it `template-sync`.
6. Sort every piece you leave out into one of two kinds, and list each under "what was
   deliberately left out" with its kind.
   - **Not carried.** Leaving it out keeps the fork as it is, and nobody has to decide
     anything: a layer or subsystem the fork does not vendor (billing where `fleet.json` ›
     `features` says `false`, a new opt-in layer), a new feature the fork has not taken up,
     a change with nothing to apply to (a bump for a dependency the fork does not have), or
     anything the fork's own records already say it does not carry. Adopting one later is a
     separate request from the owner.
   - **`needs-owner`.** Leaving it out means someone has to make a decision, or the fork goes
     on with a problem the template fixed: a bug fix or hardening for code the fork does carry
     that you could not port cleanly; a change to something the fork has that needs a product
     decision (pricing, gating, legal copy, an auth model that does not fit); or a piece you
     meant to port and could not (a refused command, a missing tool). Keep the rest of the
     sync, and give each such piece its own entry under `needs-owner`, saying what the
     decision is.
7. **Ready or draft.** Open the PR ready for review, so the merge queue lands it when green,
   only when all of these hold. Otherwise open it as a draft, label it `needs-owner`, and say
   which one failed.
   - `routines.config.md` › Autonomy grants lists `template-sync` at tier 2.
   - `bun run ci` passed here.
   - The sync touches nothing the tier-2 "never" column names (pricing, billing, auth, data
     deletion) and adds no migration.
   - Step 6 left nothing under `needs-owner`: a piece left for the owner means the owner
     reads the PR. Pieces that are only "not carried" do not hold it.
8. Journal the PR link, the template range synced, and anything left out.

## Hard limits for this routine

- Never merge directly, never use `--admin`, and never enable GitHub auto-merge. A ready PR
  is the only way this routine ships: the queue merges it.
- One PR per run, on `chore/template-sync` only.
