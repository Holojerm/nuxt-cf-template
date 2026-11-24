---
description: Bring every nuxt-cf-template fork up to date with the template, one PR per fork.
---

Bring the forks of **nuxt-cf-template** up to date with the template and open a PR on each.

$ARGUMENTS

A sync is a **layer bump**: re-pull the fork's vendored layers at one template commit. Template
features live in `layers/<name>/` (billing, credentials, feedback, files, pwa, referral, social);
the fork's `layers.lock.json` records which it vendors, at what commit and content hash, and
`layers:check` (in `bun run ci`) enforces it. Only if non-layer template files also changed since
the fork's `template.syncedSha` do you need "Core files". See `.claude/docs/patterns.md` › Vendored layers.

## Establish the real bases

Names and default branches have drifted before: derive them with commands, not memory.

1. Map checkouts to repos with `git remote get-url origin`, not directory names. Skip any app
   whose `fleet.json` › `template.repo` is not this template.
2. `git fetch origin` right before reading any ref. Read the default branch from
   `gh api repos/<owner>/<repo> -q .default_branch`.
3. Work in a worktree off the fetched ref, never in the owner's checkout (dirty, unpushed commits):
   `git -C <repo> worktree add <path> -b chore/template-sync origin/<default>`.
4. If the remote already has `chore/template-sync`, never overwrite it: push to
   `chore/template-sync-<short template sha>` and note in the PR that the old branch can go.
5. Before pushing, `git rev-list --count chore/template-sync..origin/<default>` must be 0; if not, rebase.

In a cloud session there is no `~/code`: find forks by `fleet.json` files naming this template,
clone each fresh, and branch in place.

## The layer bump

Take the template's fetched default-branch head as the commit to record, then in the fork:

```bash
bun run layers:pull --all --sha <template sha>
```

- `--all` re-pulls every layer in the lock. Use `--sha`, never `--ref <sha>`: `--ref` changes what
  the layer follows, so later pulls stay pinned to that commit.
- Each layer directory is replaced whole and the lock gets the new `sha` and `hash`. The diff is
  what the template changed; read it, don't edit it (hand edits fail `layers:check`). To change a
  layer's behaviour, shadow it, use an extension point, or fix it in the template and re-pull.
- Never add a layer the fork doesn't vendor (`layers:pull <name>` is a product decision), and a
  fork's own `layers/<domain>/` is not in the lock and is never touched.
- **Migrations.** Each fork numbers its own, so never copy a template migration. Update the fork's
  `server/db/schema.ts` (it re-exports each layer's tables), run `bun run db:generate`, and check
  the whole sequence applies in order (`cd .output && bunx wrangler d1 migrations apply <db> --local
  --persist-to .wrangler/state`). If the base gained a migration meanwhile, regenerate; never
  renumber by hand. The fork may already have ported the change: check its history first.
- Set `fleet.json` › `template.syncedSha` to the commit you pulled at, not your checkout's `HEAD`.
  Fleet's drift and `template_layer_behind` rules read it and the lock.
- Run `bun run ci` once, last, before pushing (`layers:check`, `fleet:check`, `crons:check` are in it).

## Core files

Only if `git diff --stat <syncedSha>..<template sha> -- . ':!layers'` is non-empty. Forks are plain
copies, but `syncedSha` is the merge base, so let git do the mechanical half:

```bash
git merge-tree --write-tree --name-only --merge-base=<syncedSha> HEAD <template sha>
git read-tree -m -u HEAD <the tree it printed>
```

Resolve the remaining conflicts after restoring the fork's own `README.md`, `bun.lock`,
`fleet.json`, migrations, `layers/` paths and `app-owned.json` paths. Delete empty directories the
merge leaves: an empty `layers/<name>/` registers as a Nuxt layer.

- `app-owned.json` paths are the fork's by design: never overwrite them.
- A path in `fleet.json` › `template.customized` is a declared divergence: port the change by
  hand or say why not. Every other template-owned file should end byte-identical to the template;
  fleet reports the rest as drift.
- Leave out features the fork lacks. Pricing, gating and legal copy are the owner's calls (a
  `/privacy` naming a processor the app doesn't use is wrong in a legal sense). Docs follow
  layers: `.claude/docs/{billing,referral,credentials,mcp}.md` fail `mirror:check` without their
  subsystem, so bring one only with the code it describes.
- `requireAdmin()` assumes `role = 'admin'`; a fork with another role model needs a gate that fits.
  Rewrite `robots.txt` and `sitemap.xml` for the fork's real public surface.
- Run `bun run design:check`: NuxtUI v4 doesn't define shadcn names like `border-border`, so they
  compile to nothing. Fix `AGENTS.md` too if it recommends them, or they grow back.

## Verify and ship

`bun run ci` is the floor. For runtime changes, boot the app (or `wrangler dev` on `.output`, with
the same `--cwd` for migrations and server) and check the behaviour, e.g. status codes at the
public, admin and gated boundaries. If something can't be verified, say so in the PR.

The PR body leads with what was broken and what it cost, then what came over, what was left out
and why, and how it was verified. Open it as a **draft**; run `gh pr ready` after the last push (a
push to a queued PR dequeues it). A ready PR merges itself through the merge queue: never
`gh pr merge` or `gh pr update-branch`, and don't poll checks. Keep it a draft, with the reason at
the top, when it adds a migration, changes a setting production reads, or leaves an owner decision.
`NUXT_FLEET_TOKEN` is set by the owner per fork: say so, never generate one.

Report each PR's state and any collision with the owner's uncommitted local work.
