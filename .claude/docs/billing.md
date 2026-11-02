# Billing, entitlements, referrals, MCP worker

Paddle as merchant of record, the entitlement/clawback model, and the referral reward economics. Treat `server/utils/referral.ts` as billing code: a referral reward is access nobody paid for, granted automatically, on a signal from outside the building.

> **Load this when:** touching `layers/billing/server/utils/entitlements.ts`, `server/utils/referral.ts`, `layers/billing/server/utils/paddle*.ts`, `layers/billing/server/routes/paddle/webhook.post.ts`, pricing, or the optional `mcp/` worker.
> Canonical index: [AGENTS.md](../../AGENTS.md).

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
     For a subscription that means its **first transaction**
     (`entitlements.first_transaction_id`, which Paddle sends once on
     `subscription.created`), not the `sub_` id: a refund of a later renewal
     names the renewal's transaction, finds no reward keyed on it, and claws
     nothing back. It still closes the buyer's current period (any approved
     refund ends access), and the next paid period reopens it — see the
     ordering bullet below. Only when Paddle never sent a transaction id does
     the reward fall back to the subscription id, and then a renewal refund
     does cascade.
     The cascade follows the **buyer's own row**, never the adjustment's
     `full`/`partial` label: that field is nullish in the schema and Paddle
     labels an item-level 100% refund `partial`, so keying on it failed open.
     Whenever the buyer's row is actually revoked, the reward goes with it.
     **Revoking the reward row alone takes nothing away** — rewards stack, so
     the rows above it still cover those days. The clawback measures the
     revoked window's unspent remainder (from `period_start`) and slides every
     row stacked on top of it down by that much; a chargeback the merchant
     later **wins** restores the row from `restore_period_end` and slides the
     stack back up. A reversal restores only when the buyer's own row is being
     reinstated (a `txn_` row still reading `chargeback`; a `sub_` row not
     reading `refunded`), and it restores the buyer's `txn_` pass too, since no
     Paddle lifecycle event ever will. The cascade lives inside
     `revokeForAdjustment` (`layers/billing/server/utils/entitlements.ts` ›
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
  Each grant derives a deterministic ref (`layers/billing/server/utils/paddle-refs.ts`) and the
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


## The billing layer

Billing is `layers/billing/`: the mechanism, shipped once. An app supplies its catalogue and
copy, and nothing else needs editing. What is in it: the webhook (`POST /paddle/webhook`),
signature check, idempotent event handling, the `entitlements` and `paddle_events` tables
(`server/db/schema.ts`, re-exported by the app's schema), `requireSubscription` and the other
access queries, billing state and the entitlement view, notification decisions, comp grants, the
`/pricing` scaffold, `usePaddle()`/`useEntitlement()`, the `subscription` route middleware, the
past-due banner and alert, and its tests (`layers/billing/test/`, including the replay fixtures).
Referral stays in core and registers itself with billing (below).

**What the app provides**

| What | How |
| --- | --- |
| Price ids, product id | `NUXT_PUBLIC_PADDLE_PRICE_PASS` / `_MONTHLY`, `NUXT_PADDLE_PRODUCT_ID` (optional). Declared in the layer's `runtimeConfig`, so these env names are the contract |
| Secrets | `NUXT_PADDLE_WEBHOOK_SECRET`, `NUXT_PADDLE_API_KEY`; public `NUXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NUXT_PUBLIC_PADDLE_ENV` |
| Pass length | `runtimeConfig.billing.passDays` (default 30). Plan copy that says "30 days" is the app's own file and has to move with it |
| Plan copy and amounts | Shadow the layer's `layers/billing/app/utils/plans.ts`, or its `layers/billing/app/pages/pricing.vue` for a bespoke page, or its past-due alert component for wording, by putting a file at the same path under the app's `app/`. These are client files, so an app copy wins over the layer's |
| CSP | The Paddle hosts stay in the app's `nuxt.config.ts` (the policy is one header string, not mergeable per layer) |
| What follows money arriving | `registerBillingOutcomeHandler(key, async ({ db, event, outcome }) => …)` from a Nitro plugin. Awaited in registration order, after the email and before the log lines; a throwing handler is logged and skipped, never a 500. The referral reward is one |
| Own account-deletion flow | `runtimeConfig.billing.guardDeletion: false` drops the `live_subscription` guard. For an app whose deletion cancels the subscription at Paddle itself and fails closed: the guard would refuse first, because a row only turns `canceled` when Paddle's webhook arrives |
| A missing-account event that is expected | `registerUnknownUserExpectation(key, (event) => boolean)`. Such an event is a `paddle_webhook_after_deletion` info log, not a `paddle_webhook_unknown_user` ops alert. Keep the check as narrow as the thing expected (e.g. a `subscription.*` with status `canceled`) |
| No customer email | `runtimeConfig.billing.notify: false`. The webhook and the comp routes then send nothing and log nothing for email. The layer still imports core's email and lifecycle modules, so they must exist in the app; `pass_expiring` is sent only by core's lifecycle task |
| No `paddle_*` PostHog events | `runtimeConfig.billing.analytics: false`. The webhook then sends none of the layer's own events (subscription lifecycle, transaction completed, access revoked); an app that records its own plan events does it from `registerBillingOutcomeHandler`, which still runs |
| Keep the overlap of a late pass | `runtimeConfig.billing.stackAtBilledAt: true`. A pass stacks on the access that was running when it was **bought**, not when the webhook was processed. Only differs when delivery lagged past the old pass's end (Paddle retries for days); default is the wall clock, as before |
| Extra fields on the billing view | `registerEntitlementViewFields({ key, view?, history? })` from a Nitro plugin (below). Typed by augmenting `EntitlementViewFields` / `EntitlementHistoryFields` |
| Who may use the paid thing | `requireAccess(event)` (core), backed by billing's `requireSubscription`; `findActiveEntitlement(db, userId, productKey, now?)` for anything finer |

**Extra view fields.** `buildEntitlementView` (the shape behind `GET /api/billing/entitlement`, the
admin user view and "view as") is a layer util, so an app cannot shadow it. To add a field, register
it in `layers/billing/server/utils/entitlement-view-fields.ts`:

```typescript
declare module '#layers/billing/server/utils/entitlement-view-fields' {
  interface EntitlementHistoryFields { referralKind: 'welcome' | 'reward' | null }
}
registerEntitlementViewFields({
  key: 'referral',
  history: (row) => ({ referralKind: referralRefKind(row.paddleSubscriptionId) }), // each history[] row
  view: async ({ db, userId, overview, describing }) => ({ … }), // top level; may read, never write
})
```

Nothing registered: the view is exactly what it was (same keys, same order, no extra query). Extras
are appended after the base fields; a field the base view already has is never overwritten (logged
as `billing_view_field_collision`), and a contributor that throws is logged
(`billing_view_fields_failed`) and skipped. Re-registering a key replaces it; between contributors the
later one wins a clash. Referral (core) registers `referralKind` on each history row this way
(`server/plugins/referral.ts`, `server/utils/referral-view.ts`).

**Shared Paddle account.** Paddle sends every event to every notification destination, so two
apps on one account each receive the other's. Set `NUXT_PADDLE_PRODUCT_ID` to the product this app
sells: a sale whose items are all on another product is then an info log
(`paddle_webhook_foreign_product`), not an "unrecognised price" alert. Adjustment events (refunds,
chargebacks) carry no product, so an app cannot tell the other's refunds from its own: set
`runtimeConfig.billing.alertUnmatchedAdjustments` to `false` there, and the
`paddle_adjustment_unmatched` alert stays a log line. The default (`true`) is right for an app with
its own account.

**What raises an ops alert** (`recordOpsEvent`, so a digest email; the same events are also logged):

| Kind | When |
| --- | --- |
| `paddle_webhook_unconfigured` | `NUXT_PADDLE_WEBHOOK_SECRET` unset: every delivery is being dropped (503) |
| `paddle_webhook_rejected` | Bad signature or stale timestamp (401). Mostly internet noise, but the only symptom if the secret drifts from Paddle's |
| `paddle_webhook_unparseable` | Signed body that is not JSON or not a Paddle event (400) |
| `paddle_adjustment_unmatched` | A refund/chargeback named a transaction with no entitlement (flag above) |
| `paddle_webhook_unknown_user` / `_no_user` | `custom_data.userId` names no account / is missing: nothing granted |
| `paddle_webhook_unrecognised_price` | A price not in config, on our product or with no product filter: nothing granted |

Duplicates, stale and reordered events, and another product's sale are log lines only: Paddle
retries and reorders by design.

**No foreign key on `user_id`.** A fork whose `entitlements` table predates the key keeps working: the
webhook asks `users` itself before it writes a new row and answers `unknown_user` (acknowledged, alerted)
without a row, with or without the constraint. The key stays the backstop for a race. The layer's schema
still declares it, so such a fork hand-edits the generated migration down to its additive statements.

**Vendoring and collisions.** `bun run layers:pull billing` copies it. A layer's `server/utils`
export always wins over an app file with the same name and cannot be shadowed, so a fork whose own
util collides (`billing.ts`, `entitlements.ts`, `paddle.ts`…) renames its own first. A fork whose
`entitlements` table differs from the layer's (extra or missing columns, no foreign key) must
reconcile it before re-exporting the layer's schema: `bunx drizzle-kit generate` has to say "No
schema changes". Migrations are never in the layer; their numbers are the app's.

**Replay.** `bun run build && bun run billing:replay --out dump.json` posts the signed fixtures in
`layers/billing/test/replay/` to the built Worker on a throwaway local D1 and dumps every status,
the entitlement/event/ops rows, the entitlement endpoint, export, admin and fleet payloads and the
server log records. Run it on the commit before a change and the commit after, and diff the dumps.

## Billing & MCP worker

- **Paddle billing** is pre-wired: webhook at `layers/billing/server/routes/paddle/webhook.post.ts` (HMAC-verified, outside `/api/`), `entitlements` table, `requireSubscription(event, productKey?)` server util (throws 401/402), `usePaddle()` checkout composable, and the UI on top — `/pricing` (plans from `layers/billing/app/utils/plans.ts` + price IDs in runtime config) and `/account` (status, history, self-serve cancel via the Paddle portal). `NUXT_PADDLE_API_KEY` is **required** once billing is on: the cancel button always renders for a paying customer and `POST /api/billing/portal` 503s (`portal_unconfigured`) without the key — the toast names `NUXT_PUBLIC_SUPPORT_EMAIL`; there is no "reply to your receipt email" fallback by design. Gate paid API routes with `await requireAccess(event)` (core's gate, `server/utils/access-gate.ts`; billing registers `requireSubscription` as the real check, and without billing it is just `requireUserSession`) — never trust client state for access control. Billing reaches the rest of core only through registrations (`layers/billing/server/utils/billing-extensions.ts`): the `live_subscription` deletion guard, the data-export `entitlements` section, the admin `billing` and view-as sections, the `entitlements` fleet counter and `paid` funnel stage, the onboarding `entitlementActive` signal, the `paddleEvents` purge sweep and the `pass_expiring` lifecycle step. See `patterns.md › Other seams`.
- **Events are ordered and deduplicated before anything is written.** Paddle
  retries every delivery that did not get a 2xx and documents that deliveries
  can overtake each other, so `applyPaddleEvent` reads two keys off every
  event: `event_id` and `occurred_at`. An `event_id` already in `paddle_events`
  is a `duplicate_event` no-op before any write; only events that reached a
  write path are recorded there, so a replay of one that was ignored (a price
  added to config since) still applies. Every write stamps the row's
  `last_event_at`, and a subscription or adjustment event older than that is
  refused as `stale_event` — a delayed `subscription.updated{active}` cannot
  undo a cancel, and a delayed `past_due` cannot lock out a recovered payer.
  Separately, `refunded` and `chargeback` are **terminal for lifecycle
  events**: only an adjustment sets them and only an adjustment (a reversal)
  clears them, so the routine `subscription.updated` Paddle sends for a card
  edit is refused as `terminal_status`. The one lifecycle event that may move a
  `sub_` row out of either: a **new billing period**, i.e. `current_billing_period.ends_at`
  later than the period the adjustment closed (kept in `restore_period_end`).
  The customer paid again, so the refunded period stays refunded and the new
  one counts. A won chargeback (`chargeback_reverse`) restores the disputed
  period from the same column. The
  `paddle_events` rows are swept by billing's `paddleEvents` purge contributor (run by the nightly purge task) after
  `PADDLE_EVENT_RETENTION_SECONDS` (30 days), long after Paddle stops retrying.
  All three refusals are logged as `paddle_webhook_not_applied` with the reason.
- **The webhook trusts the price, not `custom_data`.** Checkout `custom_data` is written by the browser, so only `userId` is read from it, and only to find the account. What was bought comes from the event's `items[].price.id`, matched against the configured `NUXT_PUBLIC_PADDLE_PRICE_*` values by `paddlePriceCatalogue()` in `layers/billing/server/utils/paddle-prices.ts`: a new row is created only for a configured price of the kind the event implies, and an unknown price is acknowledged, logged as `paddle_webhook_unrecognised_price`, and grants nothing. Status changes on an existing subscription row skip the check so a price rotated out of config cannot leave a cancellation unapplied. Selling a second product means a new config key and a catalogue entry — not a `productKey` branch on `custom_data`.
- **Feedback loop** is pre-wired: `<FeedbackWidget />` (mounted in the default layout) → `POST /api/feedback` (public — the auth middleware allowlists that exact method + path; the handler rate-limits by `ip_hash` in D1) → a `feedback` row in D1 **and** a server-side PostHog `feedback_submitted` event carrying the session-replay link. Never capture the same event from the client too. Read the queue with `GET /api/feedback` (admin-only via `requireAdmin()`); the `feedback-triage` routine turns it into GitHub issues.
- **MCP worker** (`mcp/`) is an optional second Worker: OAuth 2.1 (workers-oauth-provider + `OAUTH_KV`), stateless `createMcpHandler` tools at `/mcp`, sharing the app's D1 by `database_id`. The app owns all migrations; the worker reads with raw SQL. Users bridge identity with single-use connect codes (`POST /api/mcp/connect-code` ↔ the worker's `/authorize` page). Its wrangler scripts pass `-c wrangler.jsonc` — required, because the app build's `.wrangler/deploy/config.json` redirect confuses wrangler otherwise. Do not use `McpAgent` for new tools — it's deprecated in the agents SDK; `createMcpHandler` is the current path.

---


