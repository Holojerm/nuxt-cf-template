---
schedule: "0 14 * * 4"
model: sonnet
connectors: [github]
enabled: false
---

# Marketing Content

## Purpose

Turn the week's real progress into publishable marketing material — changelog, social posts, and
occasionally longer-form drafts — staged for the owner's review. Nothing is ever published
directly.

## Instructions

1. Gather the week's material: merged PRs and closed issues since the last run (`git log`,
   GitHub), the latest `ops/reports/` analytics report, and the product context + audience from
   `routines.config.md`. If the config's product context is still a placeholder, journal the gap
   and stop — marketing copy without product context is worse than none.
2. Draft into `ops/marketing/YYYY-MM-DD/` on the `ops-journal` branch:
   - `changelog.md` — user-facing changelog entries for anything shipped this week (skip
     internal chores). Plain language, benefit-first.
   - `social.md` — 2–3 short post variants (X/LinkedIn tone per the audience) for the single
     most interesting shipped thing. If nothing shipped is interesting, say so instead of
     forcing it.
   - Optionally `post.md` — an outline (not full prose) for a blog/tutorial post if the week's
     work supports one.
   Every link to the product in a draft meant for somewhere off the site is tagged per
   `_shared.md` › Tagged links, for the place that variant is written for: `utm_source=x` or
   `linkedin`, `utm_medium=social`, and as `utm_campaign` the slug of the open channel
   `growth-bet` the draft serves, or `marketing-content` when it serves none. Links inside
   `changelog.md` point at the product's own pages and carry no tags.
   Load the `copywriting` skill before drafting (and `ux-writing` for changelog entries); the
   product's published voice and step 3 win over both.
3. Ground everything in what actually shipped or measured — no invented metrics, testimonials,
   or "users love" claims (`_shared.md` rule: honest output). Match the product's existing voice
   if published copy exists in the repo.
4. **Never publish, post, schedule, or email anything** — drafts in the review folder are the
   only output.
5. Journal per `_shared.md`, linking the draft folder.
