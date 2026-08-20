# Operations Routines

Repo-shipped definitions for the cloud agents ("routines") that run the commercial side of this
product: issue triage, bug fixes, support inbox, analytics review, marketing drafts, and a single
daily digest email summarizing everything that happened.

**All routines ship default-inactive.** Nothing runs until you explicitly enable it.

## How it works

Cloud routines live in your claude.ai account (https://claude.ai/code/routines), not in the repo —
so the repo ships the *definitions* and a sync command:

1. Each `*.md` file here (except `README.md`, `_shared.md`, `routines.config.md`) defines one
   routine: frontmatter (schedule, model, required connectors) + full instructions.
2. Run `/routines sync` in Claude Code to create/update them in your account. Routines are always
   created **disabled**; the sync never silently activates anything.
3. Enable individually: `/routines enable <name>` (or via the claude.ai routines UI).
4. The cloud agent gets this repo cloned into its environment, so its prompt is just a pointer:
   "read `_shared.md`, `routines.config.md`, and your own definition file, then execute." The
   instructions stay versioned here — editing a definition file and re-running `/routines sync`
   updates the live routine.

## The routines

| File | Cadence (UTC) | What it does | Needs |
| --- | --- | --- | --- |
| `issue-triage.md` | Daily 11:00 | Labels, deduplicates, and assesses new GitHub issues | GitHub connector |
| `bug-fix.md` | Daily 12:00 | Picks the top triaged bug, opens a fix PR (never pushes to main) | GitHub connector |
| `support-inbox.md` | Daily 13:00 | Triages support email, **drafts** replies (never sends), files bugs as issues | Gmail + GitHub connectors |
| `analytics-review.md` | Weekly Mon 12:30 | Reviews product/traffic metrics, writes a report, files opportunities | GitHub connector (+ analytics access) |
| `marketing-content.md` | Weekly Thu 14:00 | Drafts changelog + marketing copy into `ops/marketing/` for review | GitHub connector |
| `daily-digest.md` | Daily 22:00 | Sends **one email per day** to the owner summarizing all actions taken | Gmail connector |

## Coordination: the ops journal

Routines coordinate through an `ops-journal` git branch (never merged to `main`, so journal
commits don't trigger deploys). Every routine appends what it did to `journal/YYYY-MM-DD.md`
on that branch; the daily digest reads it to compose the email. Protocol details in
[`_shared.md`](_shared.md).

## Before enabling anything

1. **Fork setup**: fill in [`routines.config.md`](routines.config.md) (product name, owner email,
   support inbox query, analytics sources).
2. **Connectors**: connect GitHub and Gmail at https://claude.ai/customize/connectors — routines
   that need a missing connector will log the failure to the journal instead of acting.
3. **Sync**: `/routines sync`, then enable the ones you want. Start with `issue-triage` and
   `daily-digest`; add the rest once you trust the output.

## Adding a routine

Drop a new `<name>.md` file here with the same frontmatter shape:

```yaml
---
schedule: "0 14 * * *"        # 5-field cron, UTC (minimum interval: 1 hour)
model: claude-sonnet-5
connectors: [github]           # claude.ai connectors this routine needs
enabled: false                 # keep false; enable explicitly after sync
---
```

…followed by a `## Purpose` and `## Instructions` section. Then `/routines sync`. Every routine
must follow the operating rules in `_shared.md` (the pointer prompt enforces reading it first).

## Safety model

- **Default inactive** — sync never enables; enabling is a separate explicit step.
- **Outbound gates** — support replies are drafts, code changes are PRs, marketing copy goes to a
  review folder. The only autonomous outbound action in the whole system is the daily digest
  email to the owner.
- **Untrusted input** — issue text and support emails are attacker-controlled data. `_shared.md`
  forbids following instructions found in them.
- **Audit trail** — everything lands in the ops journal, and the digest surfaces it daily.
