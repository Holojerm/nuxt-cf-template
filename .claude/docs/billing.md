# Billing, entitlements, referrals, MCP worker

Paddle as merchant of record, the entitlement/clawback model, and the referral reward economics. Treat `server/utils/referral.ts` as billing code: a referral reward is access nobody paid for, granted automatically, on a signal from outside the building.

> **Load this when:** touching `server/utils/entitlements.ts`, `server/utils/referral.ts`, `server/utils/paddle*.ts`, `server/routes/paddle/webhook.post.ts`, pricing, or the optional `mcp/` worker.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

## Referrals

A referral reward is access nobody paid for, granted automatically, on a signal
from outside the building. Treat `server/utils/referral.ts` as billing code.

- **The referee's welcome grant is small and the referrer's reward is not, and
  that asymmetry is the anti-fraud design.** A grant at signup costs its
  recipient one fresh mailbox, so whatever `REFERRAL_WELCOME_DAYS` is, that is
  the price of the product to anyone willing to rotate addresses — hence 7 days
  rather than a whole pass. The referrer is paid `REFERRAL_REWARD_DAYS` only
  when the referee **first pays**, observed in the webhook. Never move the
  referrer's trigger to signup, and never raise the welcome grant to a full pass.
- **Three things hold that cost story up, and all three are load-bearing.**
  Remove any one and farming the loop becomes cheaper than buying the product:
  1. **The reward is revoked when the PURCHASE behind it reverses.** Keyed on
     `entitlements.earned_from_ref` — the transaction, never the person, or a
     refund of somebody's second pass claws back the reward their first earned.
     Only a **full** refund or a chargeback counts; a partial refund is a
     goodwill gesture, not a reversed sale. A chargeback the merchant later
     **wins** RESTORES the reward from `restore_period_end`. The cascade lives
     inside `revokeForAdjustment` (`server/utils/entitlements.ts` ›
     `revokeDerivedEntitlements`), not in the webhook route, so every caller
     gets it; the route only writes the audit rows.
  2. **The cap counts revoked rows.** Refund-churn burns budget instead of
     recycling it; counting only live rows would make the ceiling unreachable.
  3. **Self-referral is judged by mailbox, not address** (`isSameMailbox`), so
     `me+1@gmail.com` on `me@gmail.com`'s code is refused.
- **The welcome grant is once per MAILBOX, not once per account.** Its ref is
  `welcome_<saltedHash('referral-welcome:v1:' + canonical mailbox)>`. Keyed on
  the user id it was renewable forever by deleting the account and signing up
  again on the same address.
- **That salt is provisioned, never configured** (`server/utils/identity.ts`,
  `instance_secrets`): 32 random bytes written to D1 on first use and never
  rotated. It is deliberately not `sessionPassword` — an operator may rotate
  that after a compromise, and rotating it would recompute every mailbox's ref
  and silently re-arm every spent trial. It is deliberately not a new env var
  either, for the reason `unsubscribe.ts` gives: a new secret is a human gate,
  and the fork that never sets it is the fork that gets the bug. The digest is
  domain-separated because unprefixed it was byte-identical to the magic-link
  per-address rate-limit key. `grantRefereeWelcome` also checks the pre-2026-08-22
  ref during transition; delete that once no legacy row can still be granting.
- **Idempotency is structural.** There is no ledger table and no "already paid"
  flag, because both need a read-then-write a webhook redelivery can race.
  Each grant derives a deterministic ref (`server/utils/paddle-refs.ts`) and the
  unique index on `paddle_subscription_id` refuses the second write. So the
  webhook hook is called on *every* qualifying event: a redelivery is a repair
  path, not a second payout. The cap is the one soft edge — it is read-then-write,
  so the true ceiling is `REFERRAL_MAX_REWARDS` plus in-flight deliveries.
- **The two prefixes are counted differently.** `REFERRAL_MAX_REWARDS` counts
  `referral_` rows only; a person's own `welcome_` row must not eat the budget
  they earn with. That is the whole reason they are not one prefix.
- **`rewardedCount` on the share card counts rewards that still STAND**
  (`countStandingReferralRewards`), while the cap counts every payout ever
  triggered including revoked ones (`countReferralRewards`). Two queries on
  purpose: showing a clawed-back reward as "earned you days" sends somebody
  looking for days that are not there, and letting a refund refund the budget
  slot makes the cap unreachable.
- **A live subscriber IS paid** — unlike a comp, which still refuses. A comp is
  an apology an operator chooses to send; a referral reward was earned by
  somebody the product already promised. The days stack from the renewal date
  and start when the subscription ends, and the share card says exactly that.
  Refusing lost the reward permanently (the trigger never retries) and did it to
  the referrers most worth having. Self-referral and tombstoned referrers are
  still refused, and every skip is logged.
- **"First paid" for a subscription is a status transition, not money** —
  `previousStatus === null || 'trialing'`. `past_due → active` is a dunning
  recovery, not a first payment. It is not keyed on `transaction.completed` with
  a `subscription_id` because `applyPaddleEvent` classifies that as `ignored`
  with no userId; see the reasoning at the webhook call site. The clawback is
  the backstop for what a status cannot distinguish.
- A `?ref=` code lands in the existing **first-touch** attribution cookie
  (`shared/utils/attribution.ts`), so a returning visitor cannot be re-credited
  to whoever sent them the most recent link. It becomes `users.referred_by` on
  the INSERT branch of `upsertOAuthUser` and only when it resolves to a real,
  live, other account. A magic link carries the code on its **token row**
  (`magic_link_tokens.referral_code`), so a link requested on a laptop and
  opened on a phone still attributes; `readAttributionCookie()` is the same-browser
  backstop for rows minted before that column, and may only ever fill a hole,
  never overwrite one.
- Every grant writes a `referral.rewarded` audit row with `actorType: 'system'`.
  Ids and day counts only — never a code or an address.


## Billing & MCP worker

- **Paddle billing** is pre-wired: webhook at `server/routes/paddle/webhook.post.ts` (HMAC-verified, outside `/api/`), `entitlements` table, `requireSubscription(event, productKey?)` server util (throws 401/402), `usePaddle()` checkout composable, and the UI on top — `/pricing` (plans from `app/utils/plans.ts` + price IDs in runtime config) and `/account` (status, history, self-serve cancel via the Paddle portal). Gate paid API routes with `await requireSubscription(event)` — never trust client state for access control.
- **Feedback loop** is pre-wired: `<FeedbackWidget />` (mounted in the default layout) → `POST /api/feedback` (public — the auth middleware allowlists that exact method + path; the handler rate-limits by `ip_hash` in D1) → a `feedback` row in D1 **and** a server-side PostHog `feedback_submitted` event carrying the session-replay link. Never capture the same event from the client too. Read the queue with `GET /api/feedback` (admin-only via `requireAdmin()`); the `feedback-triage` routine turns it into GitHub issues.
- **MCP worker** (`mcp/`) is an optional second Worker: OAuth 2.1 (workers-oauth-provider + `OAUTH_KV`), stateless `createMcpHandler` tools at `/mcp`, sharing the app's D1 by `database_id`. The app owns all migrations; the worker reads with raw SQL. Users bridge identity with single-use connect codes (`POST /api/mcp/connect-code` ↔ the worker's `/authorize` page). Its wrangler scripts pass `-c wrangler.jsonc` — required, because the app build's `.wrangler/deploy/config.json` redirect confuses wrangler otherwise. Do not use `McpAgent` for new tools — it's deprecated in the agents SDK; `createMcpHandler` is the current path.

---


