# Billing, entitlements, MCP worker

Paddle as merchant of record and the entitlement/clawback model. The referral reward economics are in [referral.md](referral.md): a referral reward is access nobody paid for, granted automatically, on a signal from outside the building, so treat `layers/referral/server/utils/referral.ts` as billing code.

> **Load this when:** touching `layers/billing/server/utils/entitlements.ts`, `layers/billing/server/utils/paddle*.ts`, `layers/billing/server/routes/paddle/webhook.post.ts`, pricing, or the optional `mcp/` worker.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Referrals

The referral loop is its own layer, `layers/referral/`, and meets billing only at core's seams.
Its economics, anti-fraud design, seams and what a fork does to vendor it are in
[referral.md](referral.md). The two billing facts it leans on: a reward is a `referral_<refereeId>`
row in `entitlements`, revoked by the generic `earned_from_ref` cascade inside
`revokeForAdjustment` (`layers/billing/server/utils/entitlements.ts` › `revokeDerivedEntitlements`),
and every grant is written through `getEarnedAccess()` (`layers/billing/server/utils/billing-earned-access.ts`).


## The billing layer

Billing is `layers/billing/`: the mechanism, shipped once. An app supplies its catalogue and
copy, and nothing else needs editing. What is in it: the webhook (`POST /paddle/webhook`),
signature check, idempotent event handling, the `entitlements` and `paddle_events` tables
(`server/db/schema.ts`, re-exported by the app's schema), `requireSubscription` and the other
access queries, billing state and the entitlement view, notification decisions, comp grants, the
`/pricing` scaffold, `usePaddle()`/`useEntitlement()`, the `subscription` route middleware, the
past-due banner and alert, and its tests (`layers/billing/test/`, including the replay fixtures).
The referral loop is a separate layer: it reaches billing only through core's seams
(`server/utils/billing-outcome.ts`, `entitlement-view-fields.ts`, `earned-access.ts`; see
[patterns.md](patterns.md) and [referral.md](referral.md)), and billing never imports it.

**What the app provides**

| What | How |
| --- | --- |
| Price ids, product id | `NUXT_PUBLIC_PADDLE_PRICE_PASS` / `_MONTHLY`, `NUXT_PADDLE_PRODUCT_ID` (optional). Declared in the layer's `runtimeConfig`, so these env names are the contract |
| Secrets | `NUXT_PADDLE_WEBHOOK_SECRET`, `NUXT_PADDLE_API_KEY`; public `NUXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NUXT_PUBLIC_PADDLE_ENV` |
| Pass length | `runtimeConfig.billing.passDays` (default 30). Plan copy that says "30 days" is the app's own file and has to move with it |
| Plan copy and amounts | Shadow the layer's `layers/billing/app/utils/plans.ts`, or its `layers/billing/app/pages/pricing.vue` for a bespoke page, or its past-due alert component for wording, by putting a file at the same path under the app's `app/`. These are client files, so an app copy wins over the layer's |
| CSP | The Paddle hosts stay in the app's `shared/security-headers.ts` (the policy is one header string, not mergeable per layer) |
| What follows money arriving | `registerBillingOutcomeHandler(key, async ({ db, event, outcome }) => …)` from a Nitro plugin; it is **core's** (`server/utils/billing-outcome.ts`), typed against the contract `BillingOutcomeEvent` / `BillingOutcome`, so it needs no import of this layer. Awaited in registration order, after the email and before the log lines; a throwing handler is logged and skipped, never a 500. The referral reward is one |
| Own account-deletion flow | `runtimeConfig.billing.guardDeletion: false` drops the `live_subscription` guard. For an app whose deletion cancels the subscription at Paddle itself and fails closed: the guard would refuse first, because a row only turns `canceled` when Paddle's webhook arrives |
| Cancel the subscription when the account is deleted | `runtimeConfig.billing.cancelOnDeletion: true` (`NUXT_BILLING_CANCEL_ON_DELETION`). Default false: the guard above refuses until the person has cancelled in the portal. On, deletion first cancels every live `sub_` subscription at Paddle, **immediately** (`POST /subscriptions/{id}/cancel`, `effective_from: immediately`), through the layer's Paddle client and `NUXT_PADDLE_API_KEY`, and only then deletes. **The key needs Subscriptions: write** (Paddle → Developer tools → Authentication); without it every cancel is a 403 and every deletion of a subscriber is refused. It registers a `DeletionResolver` (core seam, `server/utils/extensions.ts`) *instead of* the guard, so `guardDeletion` is moot. "Live" is `isBillingLive` (a terminal status or a scheduled cancel is not). Paddle's already-cancelled answers count as success. **Fails closed:** any other failure (no key, network, 4xx, 5xx) refuses deletion with the guard's 409 and `data: { subscriptionId }`, so `/account` offers the portal as before, and records a `deletion_cancel_failed` ops event (the id and Paddle's status and error code only; never the key, address or body). The `account.subscription_cancel_requested` audit row (ids only) is written before each call. A deletion refused after some cancels succeeded leaves those cancelled; a retry continues. `/account` says, in the delete modal and only for a live subscriber, that it will be cancelled immediately and won't renew. The `subscription.canceled` that follows is a 200: applied to the retained entitlement in the template (its account row survives as a tombstone, and no "access ended" email goes to the `.invalid` address); for a fork whose deletion removes the user row, it is the `paddle_webhook_after_deletion` info log, not an alert (the layer registers the narrow `registerUnknownUserExpectation` check itself) |
| The deletion refusal code | `runtimeConfig.billing.deletionRefusalCode` (default `live_subscription`). The 409 `data.code`, for the guard and a failed cancel alike. `/account` reads the default; an app whose own client reads another (woolholm: `billing_live`) sets it |
| A missing-account event that is expected | `registerUnknownUserExpectation(key, (event) => boolean)`. Such an event is a `paddle_webhook_after_deletion` info log, not a `paddle_webhook_unknown_user` ops alert. Keep the check as narrow as the thing expected (e.g. a `subscription.*` with status `canceled`) |
| No customer email | `runtimeConfig.billing.notify: false`. The webhook and the comp routes then send nothing and log nothing for email. The layer still imports core's email and lifecycle modules, so they must exist in the app; `pass_expiring` is sent only by core's lifecycle task |
| No `paddle_*` PostHog events | `runtimeConfig.billing.analytics: false`. The webhook then sends none of the layer's own events (subscription lifecycle, transaction completed, access revoked); an app that records its own plan events does it from `registerBillingOutcomeHandler`, which still runs |
| Keep the overlap of a late pass | `runtimeConfig.billing.stackAtBilledAt: true`. A pass stacks on the access that was running when it was **bought**, not when the webhook was processed. Only differs when delivery lagged past the old pass's end (Paddle retries for days); default is the wall clock, as before |
| Extra fields on the billing view | `registerEntitlementViewFields({ key, view?, history? })` from a Nitro plugin (below); core's, in `server/utils/entitlement-view-fields.ts`. Typed by augmenting `EntitlementViewFields` / `EntitlementHistoryFields`. The base view has no referral fields: the referral loop adds `referral` and `referralKind` this way |
| Days a feature grants that nobody paid for | `getEarnedAccess()` (core, `server/utils/earned-access.ts`): `plan` (stacks on the access running), `write` (idempotent on the ref), `exists`, `countByPrefix`. Billing registers the provider (`layers/billing/server/utils/billing-earned-access.ts`); the referral loop is its only caller. No provider, no grant, no error |
| Who may use the paid thing | `requireAccess(event)` (core), backed by billing's `requireSubscription`; `findActiveEntitlement(db, userId, productKey, now?)` for anything finer |

**Extra view fields.** `buildEntitlementView` (the shape behind `GET /api/billing/entitlement`, the
admin user view and "view as") is a layer util, so an app cannot shadow it. To add a field, register
it in core's `server/utils/entitlement-view-fields.ts` (which knows an entitlement only by its ref;
this layer widens the row type and the context with the whole row and the overview, so code in
the layer is fully typed):

```typescript
declare module '#server/utils/entitlement-view-fields' {
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
later one wins a clash. The referral loop registers `referral` and `referralKind` on each history
row and `referralKind` on the view this way (`layers/referral/server/plugins/referral.ts`,
`layers/referral/server/utils/referral-view.ts`); without it the view has none of them.

**Shared Paddle account.** Paddle sends every event to every notification destination, so two
apps on one account each receive the other's. Set `NUXT_PADDLE_PRODUCT_ID` to the product this app
sells: a sale whose items are all on another product is then an info log
(`paddle_webhook_foreign_product`), not an "unrecognised price" alert. Adjustment events (refunds,
chargebacks) carry no product, so an app cannot tell the other's refunds from its own: set
`runtimeConfig.billing.alertUnmatchedAdjustments` to `false` there, and the
`paddle_adjustment_unmatched` alert stays a log line. The default (`true`) is right for an app with
its own account.

**What raises an ops alert** (`recordOpsEvent`, so a fleet alert; the same events are also logged):

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
`--cancel-on-deletion` runs the same Worker with `billing.cancelOnDeletion` on against a stub
Paddle API the script starts (`NUXT_PADDLE_API_BASE`, a deployment never sets it) and adds the
deletion steps for it (cancel then delete, a refused cancel, an already-cancelled one, the echo
webhook); its dump gains `paddleApi`, the calls the stub saw. Without the flag the dump is that of
a build without the option.

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


