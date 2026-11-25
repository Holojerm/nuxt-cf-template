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
| Feedback queue | D1 `feedback` table (in-app widget → `POST /api/feedback`); read with the D1 read token (`_shared.md` › Reading production D1) |
| Target audience (for marketing tone) | `<who the product is for>` |
| Issue triage scope | `all` (or `routine-filed`: only issues a routine opened, `issue-triage.md` step 3) |
| X account | `<@handle>`; the automated-account label must be on before `x-replies` gets a grant |
| Public support address (optional, for `x-replies` escalations) | `<support@product.example>` |

## Autonomy grants

Routines above tier 1 act only where listed here (see `_shared.md` › Autonomy tiers). Add a line
after reading a routine's drafts for a few weeks; delete it to take the grant back. On an
operator repo (**Operator**, below) this table is not consulted: every routine acts at its
declared tier.

| Routine | Tier | Granted on |
| --- | --- | --- |
| dependency-merge | 2 | 2026-11-07 |
| pr-shepherd | 2 | 2026-11-23 |

## Operator

Turns the operator grant on for this product (`_shared.md` › Operator grant): routines act at
their declared tier with no draft period, `growth-review` runs its own flags and submits free
directory listings under the product's name, the product mails opted-in users, and
`support-inbox` sends replies. The template ships it off. It is on only when
Mode is `grow` and every row of this table holds a real value; set Mode back to `off` to take
it back.

| Key | Value |
| --- | --- |
| Mode | `off` |
| Monthly token cap (all of this product's routines together) | `<tokens per calendar month>` |
| Announcement email cap | `<announcement emails one user may get in a week, e.g. 1>` |
| Assistant signature (replies a routine sends) | `<PRODUCT_NAME> assistant` |

### Escalation list

What still goes to the owner on an operator repo, as a `needs-owner` issue (`_shared.md` ›
Escalation). The first table is the floor from `_shared.md`, repeated so the whole list is in
one place; editing it here changes nothing. Add product-specific rows to the second.

| Always the owner's |
| --- |
| Pricing, plans, discounts and trials |
| Spend of any kind (ads, tools, paid placements, paid listings) |
| Creating an account the product does not have yet |
| Refunds and billing disputes |
| Deleting or exporting a user's data |
| Support threads about billing, legal or security, and angry or churning customers |
| Anything under the owner's personal name or accounts (Hacker News, Reddit, Product Hunt and other communities, their own email) |
| Mail to anyone who has not opted in |

| Also the owner's for this product | Why |
| --- | --- |
| _(none yet)_ | |

## Mechanical fixes

The failure classes a tier-2 routine may fix and merge itself (`_shared.md` › Mechanical
fixes). One row per class. The paths are globs, and the fix may touch nothing else. Leave the
table empty until a class has been fixed by hand the same way a few times.

| Routine | Failure class (ops `kind` + cause) | Paths the fix may touch | Done-bar beyond `_shared.md` |
| --- | --- | --- | --- |
| _(none yet)_ | | | |

## Product context

Replace this section with 2–3 paragraphs about what the product does, who uses it, current
priorities, and anything a support or marketing agent should know (pricing, known limitations,
roadmap themes). Routines read this for voice and judgment — the better this section, the less
they escalate.
