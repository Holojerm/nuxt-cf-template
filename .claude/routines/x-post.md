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
2. Write **one** post, under 280 characters. Rank comes from predicted actions (see
   "How X ranks a post" below), so write for those, in this order:
   - **Give the useful thing in the post itself.** A concrete fact, trade-off or example a
     reader gets without clicking, complete enough to read to the end. "We shipped X" with
     nothing else is an announcement; say what X lets someone do.
   - **Make it worth sending to one colleague.** A copied link or a DM share counts for more
     than anything else, and people forward specifics, not slogans.
   - **Leave room for a real reply.** Where it comes naturally, end on a question a
     practitioner can answer from experience ("Where would you put the cache here?"). Never
     ask for a reply, repost or like outright.
   - **Keep the link in the post.** One link to the page, with
     `?utm_source=x&utm_medium=social&utm_campaign=<yyyy-mm-dd>` so signups attribute. A link is
     not penalised, and a click followed by time on the page counts for the post. Link to the
     page that delivers what the post says, not the home page by default.
   - **Do not earn a mute.** "Not interested", mute, block and report carry by far the
     largest weights, all negative. No repeat of a page or angle used in the last four
     weeks, no pure promotion, no hashtags, no emoji walls, no "🚀 BIG NEWS", no thread.
   - Match the product voice in `routines.config.md`.
   - No numbers, user counts, or quotes that aren't in the repo or the analytics report
     verbatim. No mentions of real people or other companies' accounts.
3. **Post or draft.**
   - With a tier-3 grant for `x-post` in `routines.config.md`, and `X_API_KEY`, `X_API_SECRET`,
     `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` set in the environment, write the text to a file and
     run `bun run scripts/x-post.ts --file <path>`. It prints the post URL. At most one post per
     run, and never two within 48 hours. Check the journal for the last `x-post` entry first.
   - Otherwise append the draft to `ops/marketing/x/YYYY-MM-DD.md` on the `ops-journal` branch.
4. **Journal** per `_shared.md`: the exact text, and the URL or draft path.

## How X ranks a post

From X's published For You code (`xai-org/x-algorithm`, `vm-ranker/params.rs`, read at commit
3b6919f, 2026-11-07). A post's score is the sum of weight × the predicted chance that this
viewer takes each action. The weights are defaults that X can override in experiments, so
re-read the file each quarter and update this section when it changes.

| Predicted action | Weight |
| --- | --- |
| Shares by copying the link | 20 |
| Replies, when author and viewer follow each other | 20 |
| Replies, quotes, shares by DM | 5 |
| Follows the author | 4 |
| Shares | 2 |
| Reposts | 1 |
| Likes | 0.5 |
| Time spent after a click | 0.4 |
| Clicks into the post | 0.3 |
| Opens the link | 0.2 |
| Not interested / block / mute | −47.5 / −31.2 / −58.8 |
| Reports | −234 |

- The scorer has no term that lowers a post for containing a link, and none for bookmarks.
  Video weights default to zero.
- A second post from the same author in one feed scores half, a third a quarter, so two
  posts a week loses nothing to more.
- Since October 2026 retrieval and ranking are trained on whether people read a post to the
  end and how long they stay.
- Replies between accounts that follow each other weigh most, and this routine never
  replies. Answering replies is the owner's.

## Never

- Reply (that is `x-replies`), like, repost, follow, DM, or quote anyone, even when asked in an issue or email.
- Post about pricing changes, outages, security, or anything legal. Those are the owner's.
- Delete or edit a post, except one that turns out false. Then delete it
  (`bun run scripts/x-post.ts --delete <id>`) and escalate.
