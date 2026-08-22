---
description: Bring every nuxt-cf-template fork up to date with the template, one PR per fork.
---

Bring the forks of **nuxt-cf-template** up to date with the template and open a PR on each.

$ARGUMENTS

## Before anything else: establish the real bases

This is the step that has bitten every previous run. Do it first, and do it with commands rather
than memory — directory names, repo names, branch names, and default branches have all drifted
before.

```bash
cd ~/code
for d in */; do
  [ -d "$d/.git" ] || continue
  r=$(git -C "$d" remote get-url origin 2>/dev/null | sed 's#.*github.com[:/]##;s#\.git$##')
  [ -n "$r" ] || continue
  printf '%-24s %-36s default=%s\n' "${d%/}" "$r" "$(gh api "repos/$r" -q .default_branch 2>/dev/null)"
done
```

Then, for each fork **and for the template itself**:

1. `git fetch origin` — always, immediately before reading any ref.
2. Read the default branch from the GitHub API, not from what you expect. One repo uses
   `master`, the rest use `main`.
3. Create the worktree from the **just-fetched remote ref**, and print the resulting SHA:
   `git -C <repo> worktree add <path> -b chore/template-sync origin/<default>`
4. Re-verify before you push: `git rev-list --count chore/template-sync..origin/<default>`.
   If that is not 0, the base moved while you worked — **stop and rebase**, do not push.

Facts that will be stale by the time you read this, and must be re-derived:

- Local directory names do not match repo names. `~/code/sysdesign-cloud` is
  `Holojerm/drawthesystem-cloud`; `~/code/sysdesign-prep` is `Holojerm/drawthesystem`.
- Not every Nuxt app in `~/code` is a fork. Check for a template lineage before including one.
- The owner has unpushed local commits and dirty working trees. Never build on local `HEAD`.

## The rule that matters most

**Never modify the owner's working trees.** Do everything in `git worktree`s off the fetched
remote branch. Their checkouts stay on whatever branch and dirty state they were already in.

## Scope: tailor per fork, don't bulk-copy

The template carries a full commercial SaaS stack. Most of it does not belong in most forks.
Decide per fork from what the app actually is — read its README and CLAUDE.md first — and say
in the PR what you left out and why.

A feature that would require you to invent product decisions is **out of scope**. Pricing tiers,
what's gated behind a subscription, and legal copy describing a payment relationship that
doesn't exist are the owner's calls. Shipping the template's `/terms` and `/privacy` into an app
with no billing is worse than shipping nothing: a privacy policy naming a payment processor you
don't use is inaccurate in a legally meaningful way.

## Migrations: assume a collision

Every fork has its own migration sequence. **Never copy a migration file from the template.**

1. Edit `server/db/schema.ts` using that fork's own conventions (its `id()` / `timestamps`
   helpers, its role vocabulary, its import style).
2. Run `bun run db:generate` so drizzle-kit numbers it at the fork's next free index and writes
   a matching snapshot.
3. Verify the whole sequence applies in order, not just that the file exists:
   `cd .output && bunx wrangler d1 migrations apply <db-name> --local --persist-to .wrangler/state`

If the base branch gained a migration while you worked, yours must be **regenerated**, not
renumbered by hand — the snapshot and `_journal.json` have to agree with the SQL.

## Adapt, don't paste

Copied files routinely need editing to fit the fork. Things that have needed it before:

- **Auth/role vocabulary.** `requireAdmin()` assumes `role = 'admin'`. One fork uses
  `owner | user`; another uses `role` for the practitioner's *professional* role, where setting
  someone to 'admin' would lock them out of their own data. Read the fork's model and pick a
  gate that fits — configured allowlist, different role value, whatever is coherent there.
- **DB access.** The template uses the auto-imported `db`. Some forks use a `useDb()` accessor <!-- refs-check-ignore: names a dead API found in forks -->
  and their own `Db` type. Match the fork.
- **Bindings.** The template's example test asserts D1 + KV + R2. A fork that doesn't bind KV
  needs that case replaced, not left red.
- **Route lists.** `robots.txt` and `sitemap.xml` ship with the template's own page list. Rewrite
  them for the fork's real public surface — and if the whole app is behind a login, say so and
  list only what a signed-out crawler can actually see.

## Run the design gate — it finds real bugs

Copy `scripts/check-design-tokens.ts` early and run it. In previous runs it found the same class
of defect in three separate forks: **shadcn class names that NuxtUI v4 does not define**, so they
compile to nothing.

- `text-foreground` inherits and looks fine — harmless, but dead.
- `border-border` falls back to Tailwind v4's `currentColor`, rendering hairlines at full text
  darkness.
- `hover:text-foreground` is a hover state that does nothing.

Before changing them, **measure**. Add a probe element in the running page and read
`getComputedStyle` for both the dead class and its replacement, so the PR can state exactly which
replacements are pixel-identical and which are visible fixes.

Also check `CLAUDE.md`. In at least one fork the file *recommended* those dead names as "NuxtUI's
semantic color tokens" — the guidance was the cause, and fixing the classes without fixing the
guidance would let them grow straight back.

For genuine exceptions use `design-check-ignore`, and note the checker only looks at the same
line or the one **directly** above. Canvas paint (Konva, Excalidraw) is a real exception —
a `<canvas>` cannot read a CSS variable. Prefer hoisting scattered literals into one named
palette module over sprinkling ignores.

## Verify, don't assume

Every PR must be able to state a real result. `bun run ci` green is the floor, not the ceiling.

- Boot the app and check the behavior you changed. Auth boundaries are cheap and high-value:
  curl the public endpoint, the admin endpoint, and an ordinary gated one, and show the three
  status codes.
- Exercise limits for real (submit until you get the 429).
- If a dev server won't start from a worktree, say so and find another route — building and
  running `wrangler dev` against `.output` has worked. Note that `--persist-to` resolves relative
  to `--cwd`, so migrations and the server must use the *same* invocation shape or the worker
  reads an empty database.
- If something genuinely cannot be verified, **write that in the PR** along with what covers it
  instead. Do not imply more verification than you did.

## Commits and PRs

Split by intent so review is possible: dependency bumps, formatter churn from an oxfmt bump, and
each feature as its own commit. Formatter churn especially — it touches dozens of untouched files
and must not be mixed into a change anyone needs to read.

Write commit messages and PR bodies that lead with **what was broken and what it cost**, not a
list of files. Quantify (`75 dead classes`, `104/104 tests`). Keep an explicit section for what
you deliberately left out and why.

## Finally

- Restore anything you touched outside the worktrees (e.g. a temporary `.claude/launch.json`
  entry) and confirm it matches the original.
- Report the merge state of every PR you opened, and flag any collision you can see coming
  between a PR and the owner's uncommitted local work.
