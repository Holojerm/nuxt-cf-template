# Routines Configuration

Product-specific values for the operations routines. **Fill this in when you fork** — routines
treat placeholder values as "not configured" and skip the dependent work (journaling the gap).

| Key | Value |
| --- | --- |
| Product name | `<PRODUCT_NAME>` |
| Production URL | `<https://product.example>` |
| Owner name | `<your name>` |
| Owner email (daily digest recipient) | `<you@example.com>` |
| GitHub repo | `<org/repo — routines can also infer this from the git remote>` |
| Support inbox search query | `<Gmail query for support mail, e.g. to:support@product.example is:unread>` |
| Support reply signature | `<PRODUCT_NAME> support` |
| Analytics sources | Cloudflare Workers analytics for the production Worker; `<add PostHog/Stripe/etc. when wired up>` |
| Feedback queue | D1 `feedback` table (in-app widget → `POST /api/feedback`); read via the Cloudflare connector (`_shared.md` › Reading production D1) |
| Target audience (for marketing tone) | `<who the product is for>` |

## Autonomy grants

Routines above tier 1 act only where listed here (see `_shared.md` › Autonomy tiers). Add a line
after reading a routine's drafts for a few weeks; delete it to take the grant back.

| Routine | Tier | Granted on |
| --- | --- | --- |
| _(none yet)_ | | |

## Product context

Replace this section with 2–3 paragraphs about what the product does, who uses it, current
priorities, and anything a support or marketing agent should know (pricing, known limitations,
roadmap themes). Routines read this for voice and judgment — the better this section, the less
they escalate.
