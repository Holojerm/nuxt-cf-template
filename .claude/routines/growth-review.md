---
schedule: "30 13 * * 1"
model: claude-opus-5-5
connectors: [github, cloudflare]
enabled: false
tier: 2
---

# Growth Review

## Purpose

The decide step of the growth loop. Once a week, after `analytics-review` has written its
report: judge last week's bets, then pick at most three new ones and ship them behind flags or as
content. It is the one routine that turns numbers into changes; everything else observes or drafts.
On an operator repo it also starts and ends the rollout of its own flags, so a bet runs from
issue to verdict with no owner step.

## Instructions

1. **Read the scoreboard.**
   - `fleet.json` › `product`: the north star, the activation event and window, the retention
     event. These are the only metrics a bet may claim to move. If `product` is null, journal
     "no product block — nothing to optimise against" and stop.
   - This week's `ops/reports/` file from `analytics-review` on the `ops-journal` branch. If it
     hasn't landed, journal that and stop. Do not recompute its numbers.
   - The 28-day funnel from D1, with the same query `server/utils/fleet-funnel.ts` runs (signups
     → activated → paid, top sources), read per `_shared.md` › Reading production D1.
   - Open and recently closed issues labelled `growth-bet`.
2. **Judge last week's bets.** For each open `growth-bet` whose minimum run length has passed,
   compare the decision metric it declared *before* it ran. Write keep / kill / inconclusive in
   the issue with the numbers, and close it. Under ~100 users per arm the result is
   inconclusive. Say so; never promote noise to a win. A killed bet gets a follow-up PR that
   removes the flag and its dead branch (tier 2 covers merging that). A kept bet gets one that
   makes the winning branch the only branch.
   On an operator repo (`_shared.md` › Operator grant) every verdict also ends the rollout, and
   an inconclusive bet is removed like a killed one. Once the PR has merged and deployed,
   retire the flag with `scripts/flags.ts` and say in the issue that it is retired. Retire it
   only after the deploy, so no user is served a branch that is gone.
3. **Pick at most three new bets.** Pick from, in order: the analytics report's recommended
   actions, churn-reason feedback, the funnel step with the worst conversion. Each bet is an
   issue labelled `growth-bet` containing:
   - the hypothesis, in one sentence
   - which `product` metric it moves, and the minimum detectable change
   - the flag name (`useFlag()` / `useFlagVariant()`), or "content — no flag" for a page
   - the minimum run length, and what keep / kill looks like, stated now
4. **Ship them.** One PR per bet, on a `growth/<slug>` branch, following the repo's AGENTS.md and
   `bun run ci`:
   - A code bet goes behind a flag that defaults **off**, named `growth-<slug>` to match its
     branch.
     - On an operator repo, start the rollout yourself once the PR has merged and the deploy is
       live: create the flag and roll it out with `scripts/flags.ts` at the split the issue
       declared, then write the start time and the split in the issue. The minimum run length
       counts from there. Only flags this routine created, and only through the script. If the
       PR has not merged by the end of this run, write "rollout pending" in the issue and do
       not wait: the next run starts every pending rollout before it judges anything. If the
       script or its PostHog key is missing, fall back to the next bullet and journal the gap.
     - On any other repo, leave the rollout to the owner and say in the issue which rollout you
       recommend. Turning a flag on is theirs.
   - A content bet (a blog post, an SEO page, better copy on an existing public page) needs no
     flag. It must be true, specific, and grounded in what the product does today.
   - Stay inside tier 2 as `_shared.md` defines it. Pricing, billing, auth, emails to users, and
     anything that deletes data are out of scope, so file an issue labelled `needs-owner`
     instead. The one exception is email on an operator repo: a bet may be a lifecycle step or
     an announcement, shipped as a PR and sent by the product's own send path inside the
     bounds and caps of the operator grant.
   - With a tier-2 grant in `routines.config.md`, or on an operator repo, merge your own PR once
     CI is green. Otherwise leave it open for the owner.
5. **Journal** per `_shared.md`. List each bet as a line with its issue, PR, and decision metric,
   and each judged bet with its verdict.

## Never

- Claim a result the data does not show, or pick a decision metric after seeing the numbers.
- Stack more than three live bets on the same funnel step. They confound each other.
- Touch the rollout or targeting of a flag this routine did not create, or one not named
  `growth-…`. On a repo without the operator grant, touch no flag's rollout at all.
- Change a flag any way but `scripts/flags.ts`: no PostHog dashboard, no direct API call, no
  other PostHog setting.
- Change a live bet's split or audience after its rollout started. End it and file a new bet.
