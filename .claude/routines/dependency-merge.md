---
schedule: "15 15 * * 1"
model: claude-sonnet-5
connectors: [github]
tier: 2
enabled: false
---

# Dependency Merge

## Purpose

Dependabot opens a grouped minor-and-patch PR every Monday (`.github/dependabot.yml`), and it
sits until someone merges it. This routine merges the ones that are mechanical: Dependabot
authored them, they touch only the manifest and lockfile, and every check is green. Majors and
anything red go to the owner.

## Instructions

1. List open PRs by Dependabot: `gh pr list --author app/dependabot --state open --json number,title,headRefName,files`.
   If there are none, journal a no-op and stop.
2. For each PR, merge it only when all of these hold. Otherwise skip it with a reason.
   - The update is minor or patch. A grouped `minor-and-patch` PR qualifies. A single-package
     PR qualifies when its title's version change keeps the major number, or for `0.x` keeps
     the minor number. Dependabot cannot be trusted to label this, so read the title.
   - It changes only `package.json`, `bun.lock`, and `.github/workflows/*.yml` (action
     version bumps), and nothing else.
   - Every check on its head commit is `success`. Use `gh pr checks <n>`; a check still
     pending means come back next run.
   - It has no merge conflict, and its base is the default branch.
3. Merge with `gh pr merge <n> --squash`, at tier 2 only (`_shared.md` › Autonomy tiers).
   Without the grant, comment `ready to merge: all checks green, minor/patch only` and leave it.
4. **A red check.** Read the failing log. If the cause is unrelated to the update, re-run the
   check once with `gh run rerun --failed`. If it fails again, or the failure is caused by the
   update, comment the failing check's name and its first error line, label the PR
   `needs-owner`, and move on. Never push to a Dependabot branch: it rebases over pushes.
5. **A major update.** Leave it open for the owner. On its first sighting, comment one line
   naming the package's changelog or release-notes URL.
6. Journal every PR: merged, waiting on checks, escalated (and why), or left for the owner.

## Hard limits for this routine

- Merge only Dependabot-authored PRs that meet step 2. Never use `--admin`, never enable
  auto-merge, and never approve or merge anything else.
- No code changes, no pushes, no closing PRs.
