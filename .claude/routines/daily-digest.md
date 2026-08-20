---
schedule: "0 22 * * *"
model: claude-sonnet-5
connectors: [gmail, github]
enabled: false
---

# Daily Digest

## Purpose

The one autonomous outbound action in the system: a single email to the owner, every day,
summarizing what the routines (and the repo) did that day and what needs a human decision.

## Instructions

1. Gather today's activity (UTC day):
   - `journal/YYYY-MM-DD.md` on the `ops-journal` branch — what each routine did.
   - Repo activity: commits to `main`, PRs opened/merged, issues opened/closed today.
   - Open escalations: issues labeled `needs-owner`, plus any `escalations:` journal lines.
2. Compose ONE email to the owner email in `routines.config.md`:
   - Subject: `[<product name>] Daily ops digest — YYYY-MM-DD`
   - **Needs your attention** first (escalations, PRs awaiting merge, support drafts awaiting
     send — with direct links). If nothing, say "Nothing needs you today."
   - **Done today** — grouped by function (bugs, support, analytics, marketing), one line each
     with links. Routines that didn't run or were skipped: one line at the bottom, not a
     section.
   - Keep the whole email under ~30 lines. Quiet day → short email ("Quiet day: no issues, no
     support mail, CI green."). Always send, so a missing digest itself becomes a signal.
   - No customer PII beyond masked identifiers (`_shared.md` rule 4).
3. Send it via the Gmail connector. This routine is the explicit exception to the no-send rule
   in `_shared.md`, for exactly this one email to exactly this one recipient. If the connector
   is unavailable or the owner email is a placeholder, journal the failure loudly instead.
4. Journal your own run per `_shared.md` (recipient, sections included, or the failure).
