---
schedule: "0 12 * * *"
model: claude-sonnet-5
connectors: [github]
tier: 2
enabled: false
---

# Bug Fix

## Purpose

Work the triaged bug queue: one well-tested fix PR per run, highest severity first. With a
tier-2 grant the PR merges itself through the merge queue once its checks pass. Without one it
is a draft the owner readies.

## Instructions

1. Pick the highest-priority open issue labeled `bug` that is reproducible (has a triage comment
   confirming reproduction), is not labeled `needs-more-info` or `needs-owner`, and has no open
   PR already linked. Severity order: `sev:critical`, `sev:high`, `sev:normal`, `sev:low`.
   If the queue is empty, journal a no-op and stop.
2. Read `AGENTS.md` for the project's stack and coding standards, then fix the bug:
   - Branch: `fix/<issue-number>-<slug>` off `main`.
   - Write or update a test that fails before the fix and passes after — a fix without a
     regression test isn't done unless the bug is genuinely untestable (say why in the PR).
   - Keep the diff minimal: fix the bug, don't refactor around it (`_shared.md` rule 7).
3. Verify with the repo's own gate: `bun run ci` (lint + typecheck + test + build). Don't open
   the PR until it passes.
4. Open a PR: describe the root cause, the fix, and the test; link `Fixes #<issue>`. Open it
   ready for review only when `routines.config.md` › Autonomy grants lists `bug-fix` at tier 2,
   the fix has a regression test that failed before it, and the diff touches nothing the
   tier-2 "never" column names and adds no migration, dependency, or CI or config change.
   Otherwise open it as a draft and say which of those failed. Comment on
   the issue with the PR link. **Never push to `main`** (`_shared.md` rule 1).
5. One PR per run. If the fix balloons beyond ~300 changed lines or requires a design decision,
   stop, comment your findings on the issue, label it `needs-owner`, and journal the escalation.
6. Journal the run per `_shared.md`.
