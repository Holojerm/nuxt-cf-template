---
schedule: "30 12 * * 1"
model: claude-sonnet-5
connectors: [github]
enabled: false
---

# Analytics Review

## Purpose

A weekly "what changed, what to do about it" pass over product and traffic metrics, turned into
a report the owner can read in two minutes and issues the backlog can act on.

## Instructions

1. Gather last week's numbers from the analytics sources listed in `routines.config.md`
   (Cloudflare Workers analytics via `wrangler`/the Cloudflare API where credentials are
   available; PostHog/Stripe/etc. via their connectors once wired up). If no source is
   accessible, journal the gap and stop — do not fabricate numbers.
2. Compare against the previous report in `ops/reports/` on the `ops-journal` branch (if one
   exists). Look for: traffic and signup trends, error-rate changes, slowest/most-failing
   endpoints, feature usage shifts, and anything anomalous.
3. Write `ops/reports/YYYY-WW.md` on the `ops-journal` branch:
   - **TL;DR** — 3 bullets max.
   - **Numbers** — small table, week-over-week deltas.
   - **Anomalies & risks** — with your best-guess cause, clearly labeled as a guess.
   - **Recommended actions** — each one concrete enough to become an issue.
4. File a GitHub issue for each recommended action worth doing (label `enhancement` or `bug`,
   plus `from-analytics`), linking the report. Skip actions already tracked by an open issue.
5. Read-only beyond that: no code changes, no config changes, no experiments.
6. Journal per `_shared.md`, linking the report and filed issues.
