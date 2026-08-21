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

   Four funnels now have first-party data behind them — check each one explicitly, because
   they are where the money leaks and none of them existed in earlier reports:

   - **Checkout abandonment.** `checkout_started` → `checkout_completed`, with
     `checkout_abandoned` in between (app/utils/checkout.ts). Segment by price id. A rise here
     is worth more attention than an equivalent drop in signups.
   - **Acquisition by channel.** `users.signup_source` / `signup_medium` / `signup_campaign`
     joined against `entitlements` in D1 — that is paying customers per channel, not visits.
     Query it with `wrangler d1 execute --remote`, and prefer it over PostHog's
     `$initial_utm_*` when the two disagree: ad blockers make the PostHog figure a
     non-random undercount.
   - **Churn reasons.** `feedback` rows with `kind = 'churn'`, written by the cancellation
     prompt on /account. Small numbers, high signal — quote them verbatim rather than
     summarising, and never average them into a sentiment score.
   - **Unanswered feedback.** Rows where `replied_at IS NULL` and `created_at` is more than a
     week old. Rising = the loop is open at the human end; say so plainly in the TL;DR.
3. Write `ops/reports/YYYY-WW.md` on the `ops-journal` branch:
   - **TL;DR** — 3 bullets max.
   - **Numbers** — small table, week-over-week deltas.
   - **Anomalies & risks** — with your best-guess cause, clearly labeled as a guess.
   - **Recommended actions** — each one concrete enough to become an issue.
4. File a GitHub issue for each recommended action worth doing (label `enhancement` or `bug`,
   plus `from-analytics`), linking the report. Skip actions already tracked by an open issue.
5. **Experiments: propose, never run.** Where a recommendation is a genuine coin-flip —
   pricing layout, onboarding order, copy on the paid CTA — write it up as an experiment
   proposal in the report and file it as an issue labelled `experiment`: the hypothesis, the
   flag name it would use (`useFlag()` / `useFlagVariant()`, app/composables/useFlag.ts), the
   single metric that decides it, and the minimum run length. Do **not** create the PostHog
   flag, change its rollout, or alter targeting. A routine that can start experiments can
   also silently change what customers are charged.

   State the decision metric before the experiment runs. Choosing it afterwards from whatever
   moved is how an A/B programme produces a year of wins and no revenue.
6. Read-only beyond that: no code changes, no config changes.
7. Journal per `_shared.md`, linking the report and filed issues.
