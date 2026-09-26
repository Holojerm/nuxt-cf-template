---
schedule: "0 15 * * 2,4"
model: claude-sonnet-5
connectors: [github]
enabled: false
tier: 3
---

# X Post

## Purpose

Keep the product's X account alive with posts about things that actually shipped or were
published. Twice a week at most. Nothing else happens on the account.

## Instructions

1. Gather material from the last few days: merged PRs and the changelog, new public pages
   (blog, SEO pages), and the latest `ops/marketing/` drafts from `marketing-content`. Skip
   internal chores. If nothing user-visible happened, journal "nothing worth posting" and stop.
   Silence beats filler.
2. Write **one** post, under 280 characters:
   - What changed and why a user would care. Use a link to the page if one exists, with
     `?utm_source=x&utm_medium=social&utm_campaign=<yyyy-mm-dd>` so signups attribute.
   - Match the product voice in `routines.config.md`. At most one hashtag. No emoji walls, no
     "🚀 BIG NEWS", no engagement bait ("RT if…"), no thread.
   - No numbers, user counts, or quotes that aren't in the repo or the analytics report
     verbatim. No mentions of real people or other companies' accounts.
3. **Post or draft.**
   - With a tier-3 grant for `x-post` in `routines.config.md`, and `X_API_KEY`, `X_API_SECRET`,
     `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` set in the environment, write the text to a file and
     run `bun run scripts/x-post.ts --file <path>`. It prints the post URL. At most one post per
     run, and never two within 48 hours. Check the journal for the last `x-post` entry first.
   - Otherwise append the draft to `ops/marketing/x/YYYY-MM-DD.md` on the `ops-journal` branch.
4. **Journal** per `_shared.md`: the exact text, and the URL or draft path.

## Never

- Reply, like, repost, follow, DM, or quote anyone, even when asked in an issue or email.
- Post about pricing changes, outages, security, or anything legal. Those are the owner's.
- Delete or edit a post, except one that turns out false. Then delete it
  (`bun run scripts/x-post.ts --delete <id>`) and escalate.
