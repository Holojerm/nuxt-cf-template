# Billing, entitlements, MCP worker

Stripe Managed Payments (Stripe, as Link, is the merchant of record) and the entitlement/clawback model. The referral reward economics are in [referral.md](referral.md): a referral reward is access nobody paid for, granted automatically, on a signal from outside the building, so treat `layers/referral/server/utils/referral.ts` as billing code.

> **Load this when:** touching `layers/billing/server/utils/entitlements.ts`, `layers/billing/server/utils/stripe*.ts`, `layers/billing/server/routes/stripe/webhook.post.ts`, pricing, or the optional `mcp/` worker.
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
copy, and nothing else needs editing. What is in it: the webhook (`POST /stripe/webhook`),
signature check, idempotent event handling, hosted Checkout (`POST /api/billing/checkout`), the `entitlements` and `billing_events` tables
(`server/db/schema.ts`, re-exported by the app's schema), `requireSubscription` and the other
access queries, billing state and the entitlement view, notification decisions, comp grants, the
`/pricing` scaffold, `useCheckout()`/`useEntitlement()`, the `subscription` route middleware, the
past-due banner and alert, and its tests (`layers/billing/test/`, including the replay fixtures).
The referral loop is a separate layer: it reaches billing only through core's seams
(`server/utils/billing-outcome.ts`, `entitlement-view-fields.ts`, `earned-access.ts`; see
[patterns.md](patterns.md) and [referral.md](referral.md)), and billing never imports it.

**What the app provides**

| What | How |
| --- | --- |
| Price ids, product id | `NUXT_PUBLIC_STRIPE_PRICE_MONTHLY` / `_PASS`, `NUXT_STRIPE_PRODUCT_ID` (optional). Declared in the layer's `runtimeConfig`, so these env names are the contract. The product needs an eligible tax code in Stripe (`txcd_10103000`, SaaS for personal use), or Managed Payments refuses the sale |
| Secrets | `NUXT_STRIPE_SECRET_KEY` (its prefix, `sk_test_` or `sk_live_`, picks test or live mode, so there is no environment variable), `NUXT_STRIPE_WEBHOOK_SECRET`. Nothing public beyond the price ids: Checkout is hosted, so no browser script loads |
| Pass length | `runtimeConfig.billing.passDays` (default 30). Plan copy that says "30 days" is the app's own file and has to move with it |
| Plan copy and amounts | Shadow the layer's `layers/billing/app/utils/plans.ts`, or its `layers/billing/app/pages/pricing.vue` for a bespoke page, or its past-due alert component for wording, by putting a file at the same path under the app's `app/`. These are client files, so an app copy wins over the layer's |
| CSP | The policy lives in the app's `shared/security-headers.ts` (one header string, not mergeable per layer). Checkout and the portal are redirects to Stripe's hosted pages, so no Stripe host needs allowing for them |
| What follows money arriving | `registerBillingOutcomeHandler(key, async ({ db, event, outcome }) => …)` from a Nitro plugin; it is **core's** (`server/utils/billing-outcome.ts`), typed against the contract `BillingOutcomeEvent` / `BillingOutcome`, so it needs no import of this layer. Awaited in registration order, after the email and before the log lines; a throwing handler is logged and skipped, never a 500. The referral reward is one |
| Own account-deletion flow | `runtimeConfig.billing.guardDeletion: false` drops the `live_subscription` guard. For an app whose deletion cancels the subscription at Stripe itself and fails closed: the guard would refuse first, because a row only turns `canceled` when Stripe's webhook arrives |
| Cancel the subscription when the account is deleted | `runtimeConfig.billing.cancelOnDeletion: true` (`NUXT_BILLING_CANCEL_ON_DELETION`). Default false: the guard above refuses until the person has cancelled in the portal. On, deletion first cancels every live `sub_` subscription at Stripe, **immediately** (`DELETE /v1/subscriptions/{id}`), through the layer's Stripe client (`layers/billing/server/utils/stripe-api.ts`) and `NUXT_STRIPE_SECRET_KEY`, and only then deletes. **A restricted key needs Subscriptions: write** (Stripe → Developers → API keys); without it every cancel is a 403 and every deletion of a subscriber is refused. It registers a `DeletionResolver` (core seam, `server/utils/extensions.ts`) *instead of* the guard, so `guardDeletion` is moot. "Live" is `isBillingLive` (a terminal status or a scheduled cancel is not). A subscription that Stripe refuses to cancel but that reads back as `canceled` (or is gone) counts as success. **Fails closed:** any other failure (no key, network, 4xx, 5xx) refuses deletion with the guard's 409 and `data: { subscriptionId }`, so `/account` offers the portal as before, and records a `deletion_cancel_failed` ops event (the id and Stripe's status and error code only; never the key, address or body). The `account.subscription_cancel_requested` audit row (ids only) is written before each call. A deletion refused after some cancels succeeded leaves those cancelled; a retry continues. `/account` says, in the delete modal and only for a live subscriber, that it will be cancelled immediately and won't renew. The `subscription.canceled` that follows is a 200: applied to the retained entitlement in the template (its account row survives as a tombstone, and no "access ended" email goes to the `.invalid` address); for a fork whose deletion removes the user row, it is the `stripe_webhook_after_deletion` info log, not an alert (the layer registers the narrow `registerUnknownUserExpectation` check itself) |
| The deletion refusal code | `runtimeConfig.billing.deletionRefusalCode` (default `live_subscription`). The 409 `data.code`, for the guard and a failed cancel alike. `/account` reads the default; an app whose own client reads another (woolholm: `billing_live`) sets it |
| A missing-account event that is expected | `registerUnknownUserExpectation(key, (event) => boolean)`. Such an event is a `stripe_webhook_after_deletion` info log, not a `stripe_webhook_unknown_user` ops alert. Keep the check as narrow as the thing expected (e.g. a `subscription.*` with status `canceled`) |
| No customer email | `runtimeConfig.billing.notify: false`. The webhook and the comp routes then send nothing and log nothing for email. The layer still imports core's email and lifecycle modules, so they must exist in the app; `pass_expiring` is sent only by core's lifecycle task |
| No `billing_*` PostHog events | `runtimeConfig.billing.analytics: false`. The webhook then sends none of the layer's own events (subscription lifecycle, transaction completed, access revoked); an app that records its own plan events does it from `registerBillingOutcomeHandler`, which still runs |
| Keep the overlap of a late pass | `runtimeConfig.billing.stackAtBilledAt: true`. A pass stacks on the access that was running when it was **bought**, not when the webhook was processed. Only differs when delivery lagged past the old pass's end (Stripe retries for up to 3 days); default is the wall clock, as before |
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
  history: (row) => ({ referralKind: referralRefKind(row.billingRef) }), // each history[] row
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

**Shared Stripe account.** Stripe sends every event to every webhook endpoint on an account, so two
apps on one account each receive the other's. Set `NUXT_STRIPE_PRODUCT_ID` to the product this app
sells: a sale whose items are all on another product is then an info log
(`stripe_webhook_foreign_product`), not an "unrecognised price" alert. Refund and dispute events carry
no product, so an app cannot tell the other's refunds from its own: set
`runtimeConfig.billing.alertUnmatchedAdjustments` to `false` there, and the
`stripe_adjustment_unmatched` alert stays a log line. The default (`true`) is right for an app with
its own account.

**What raises an ops alert** (`recordOpsEvent`, so a fleet alert; the same events are also logged):

| Kind | When |
| --- | --- |
| `stripe_webhook_unconfigured` | `NUXT_STRIPE_WEBHOOK_SECRET` or `NUXT_STRIPE_SECRET_KEY` unset: every delivery is being dropped (503) |
| `stripe_webhook_rejected` | Bad signature or stale timestamp (401). Mostly internet noise, but the only symptom if the secret drifts from the endpoint's |
| `stripe_webhook_unparseable` | Signed body that is not JSON, not a Stripe event, or a handled event type whose object has the wrong shape, usually an endpoint on another API version (400) |
| `stripe_webhook_lookup_failed` | A call to Stripe the event needed (a Checkout Session's line items, the invoice behind a refund) failed. Nothing was written and the answer is 502, so Stripe redelivers |
| `stripe_adjustment_unmatched` | A refund/dispute named a payment with no entitlement (flag above) |
| `stripe_webhook_unknown_user` / `_no_user` | `metadata.userId` names no account / is missing: nothing granted |
| `stripe_webhook_unrecognised_price` | A price not in config, on our product or with no product filter: nothing granted |

Duplicates, stale and reordered events, and another product's sale are log lines only: Stripe
retries and reorders by design.

**No foreign key on `user_id`.** A fork whose `entitlements` table predates the key keeps working: the
webhook asks `users` itself before it writes a new row and answers `unknown_user` (acknowledged, alerted)
without a row, with or without the constraint. The key stays the backstop for a race. The layer's schema
still declares it, so such a fork hand-edits the generated migration down to its additive statements.

**Vendoring and collisions.** `bun run layers:pull billing` copies it. A layer's `server/utils`
export always wins over an app file with the same name and cannot be shadowed, so a fork whose own
util collides (`billing.ts`, `entitlements.ts`, `stripe.ts`…) renames its own first. A fork whose
`entitlements` table differs from the layer's (extra or missing columns, no foreign key) must
reconcile it before re-exporting the layer's schema: `bunx drizzle-kit generate` has to say "No
schema changes". Migrations are never in the layer; their numbers are the app's. A fork that already has the
old tables writes its own migration to rename them, then runs `bunx drizzle-kit generate` and expects "No schema
changes" (add the index renames it asks for):

```sql
-- destructive-ok: renames only, no data lost
ALTER TABLE entitlements RENAME COLUMN billing_ref TO billing_ref;
ALTER TABLE entitlements RENAME COLUMN provider_customer_id TO provider_customer_id;
ALTER TABLE billing_events RENAME TO billing_events;
```

**Replay.** `bun run build && bun run billing:replay --out dump.json` posts the signed fixtures in
`layers/billing/test/replay/` to the built Worker on a throwaway local D1 and dumps every status,
the entitlement/event/ops rows, the entitlement endpoint, export, admin and fleet payloads and the
server log records. Run it on the commit before a change and the commit after, and diff the dumps.
`--cancel-on-deletion` runs the same Worker with `billing.cancelOnDeletion` on against a stub
Stripe API the script starts (`NUXT_STRIPE_API_BASE`, a deployment never sets it) and adds the
deletion steps for it (cancel then delete, a refused cancel, an already-cancelled one, the echo
webhook); its dump gains `stripeApi`, the calls the stub saw. Without the flag the dump is that of
a build without the option.

**Running the layer's e2e in a fork.** `layers/billing/test/e2e/` (project `e2e-billing`) is vendored
byte for byte, so it cannot be edited per product. It reads one optional fork-owned file,
`test/e2e/billing.e2e.ts`, whose default export is a `Partial<BillingE2e>` (type and defaults in <!-- refs-check-ignore: fork-owned file, absent in the template -->
`layers/billing/test/e2e/fork-config.ts`). With no file the specs are exactly the template's.

| Key | Default | Meaning |
|---|---|---|
| `gatedPath` | `'/dashboard'` | The plan-gated page. `null` = the product gates an action, not a page: redirect, upsell-copy and unlocked-content assertions are skipped; the signed webhook → `/api/billing/entitlement` active/inactive/past_due assertions still run. |
| `gatedCopy` | `'That page needs an active plan'` | Text the upsell page shows after a bounce. |
| `upsellPathPrefix` | `'/pricing'` | Where a plan-less account lands. (past_due always lands on `/account`.) |
| `unlockedHeading`, `unlockedText` | `/Welcome back/`, `'Get set up'` | What proves `gatedPath` rendered for an entitled user; `null` skips. `unlockedText` is checked in the one-time-pass case only. |
| `signIn(request, user)` | `null` = `POST /api/auth/dev` | Signs `user` in on a fresh request context (its cookie jar becomes the session) and returns `{ userId }`. A request context, not a page, because sign-in is cached per worker to stay under the auth rate limit. |
| `accessProbe({ request, page }, 'granted' \| 'denied')` | `null` | Extra product-level check run wherever a spec asserts access, in addition to the entitlement endpoint. |

No gated page, paid access enforced at an API route (woolholm: `POST /api/games`):

```ts
import { expect } from '@playwright/test'
import type { BillingE2e } from '../../layers/billing/test/e2e/fork-config'
export default {
  gatedPath: null,
  async accessProbe({ request }, expected) {
    const res = await request.post('/api/games', { data: {} })
    expect(res.status() === 402).toBe(expected === 'denied')
  },
} satisfies Partial<BillingE2e>
```

Gated page and its own sign-in (drawthesystem-cloud: `/sessions`, seeded `dev-login`):

```ts
export default {
  gatedPath: '/sessions',
  gatedCopy: 'No pass right now.',
  unlockedHeading: /Sessions/,
  unlockedText: null,
  async signIn(request, { email }) {
    const res = await request.post('/api/auth/dev-login', { data: { email } })
    return { userId: ((await res.json()) as { user: { id: string } }).user.id }
  },
} satisfies Partial<BillingE2e>
```

(The values above are the shape, not verified fork routes: read the fork's own sign-in and gated page.)

## Billing & MCP worker

- **Stripe billing** is pre-wired: webhook at `layers/billing/server/routes/stripe/webhook.post.ts` (HMAC-verified, outside `/api/`), `entitlements` table, `requireSubscription(event, productKey?)` server util (throws 401/402), `useCheckout()` and the UI on top — `/pricing` (plans from `layers/billing/app/utils/plans.ts` + price IDs in runtime config) and `/account` (status, history, self-serve cancel via the Stripe customer portal). The sale itself is Stripe Managed Payments: Stripe, as Link, is the merchant of record and handles tax, fraud and disputes; customers see "Sold through Link" and `LINK.COM* <descriptor>` on their statements; if a customer's support question goes unanswered for 48 hours Stripe may refund them. It works only on hosted Checkout, so `POST /api/billing/checkout` (body `{ plan: 'monthly' | 'pass' }`, signed-in only, returns `{ url }`, 503 `checkout_unconfigured`, 502 `checkout_failed`) creates a Checkout Session with `managed_payments[enabled]=true` and the browser redirects there; success returns to `/pricing?checkout=success`, which grants nothing, because access arrives with the webhook. The product needs an eligible tax code (`txcd_10103000`). **Webhook setup:** create the endpoint in Stripe (Developers → Webhooks) at `POST /stripe/webhook` on API version `STRIPE_API_VERSION` (`layers/billing/server/utils/stripe-api.ts`; payload shapes follow the endpoint's version, not the request header), subscribe it to `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and `.resumed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `.closed` and `.funds_reinstated`, and set its signing secret as `NUXT_STRIPE_WEBHOOK_SECRET`. `layers/billing/server/utils/stripe-events.ts` translates each into the layer's own billing event; the mapping table is in its header. **The portal** needs the customer portal saved once in the Stripe Dashboard (Settings → Billing → Customer portal) with cancellation set to "at end of billing period", which is what the layer assumes. `NUXT_STRIPE_SECRET_KEY` is **required** once billing is on: checkout, `POST /api/billing/portal` and the webhook's own lookups all call Stripe, and each 503s (`checkout_unconfigured`, `portal_unconfigured`) or drops the event without it — the toast names `NUXT_PUBLIC_SUPPORT_EMAIL`; there is no "reply to your receipt email" fallback by design. A restricted key needs write on Checkout Sessions, Customer portal and Subscriptions, and read on Invoices. Gate paid API routes with `await requireAccess(event)` (core's gate, `server/utils/access-gate.ts`; billing registers `requireSubscription` as the real check, and without billing it is just `requireUserSession`) — never trust client state for access control. Billing reaches the rest of core only through registrations (`layers/billing/server/utils/billing-extensions.ts`): the `live_subscription` deletion guard, the data-export `entitlements` section, the admin `billing` and view-as sections, the `entitlements` fleet counter and `paid` funnel stage, the onboarding `entitlementActive` signal, the `billingEvents` purge sweep and the `pass_expiring` lifecycle step. See `patterns.md › Other seams`.
- **Events are ordered and deduplicated before anything is written.** Stripe
  retries every delivery that did not get a 2xx and does not guarantee delivery
  order, so `applyBillingEvent` reads two keys off every
  event: `event_id` and `occurred_at`. An `event_id` already in `billing_events`
  is a `duplicate_event` no-op before any write; only events that reached a
  write path are recorded there, so a replay of one that was ignored (a price
  added to config since) still applies. Every write stamps the row's
  `last_event_at`, and a subscription or adjustment event older than that is
  refused as `stale_event` — a delayed `subscription.updated{active}` cannot
  undo a cancel, and a delayed `past_due` cannot lock out a recovered payer.
  Separately, `refunded` and `chargeback` are **terminal for lifecycle
  events**: only an adjustment sets them and only an adjustment (a reversal)
  clears them, so the routine `customer.subscription.updated` Stripe sends for a card
  edit is refused as `terminal_status`. The one lifecycle event that may move a
  `sub_` row out of either: a **new billing period**, i.e. `current_billing_period.ends_at`
  (Stripe's `current_period_end`) later than the period the adjustment closed (kept in `restore_period_end`).
  The customer paid again, so the refunded period stays refunded and the new
  one counts. A won chargeback (`chargeback_reverse`) restores the disputed
  period from the same column. The
  `billing_events` rows are swept by billing's `billingEvents` purge contributor (run by the nightly purge task) after
  `BILLING_EVENT_RETENTION_SECONDS` (30 days), long after Stripe stops retrying.
  All three refusals are logged as `stripe_webhook_not_applied` with the reason.
- **The webhook trusts the price, not the metadata.** The checkout route stamps `metadata.userId` from the session, so only `userId` is read from it, and only to find the account. What was bought comes from the event's `items[].price.id` (a Checkout Session's line items are fetched from Stripe, since the webhook payload carries none), matched against the configured `NUXT_PUBLIC_STRIPE_PRICE_*` values by `priceCatalogue()` in `layers/billing/server/utils/stripe-prices.ts`: a new row is created only for a configured price of the kind the event implies, and an unknown price is acknowledged, logged as `stripe_webhook_unrecognised_price`, and grants nothing. Status changes on an existing subscription row skip the check so a price rotated out of config cannot leave a cancellation unapplied. Selling a second product means a new config key and a catalogue entry — not a `productKey` branch on metadata.
- **Feedback loop** is pre-wired: `<FeedbackWidget />` (mounted in the default layout) → `POST /api/feedback` (public — the auth middleware allowlists that exact method + path; the handler rate-limits by `ip_hash` in D1) → a `feedback` row in D1 **and** a server-side PostHog `feedback_submitted` event carrying the session-replay link. Never capture the same event from the client too. Read the queue with `GET /api/feedback` (admin-only via `requireAdmin()`); the `feedback-triage` routine turns it into GitHub issues.
- **MCP worker** (`mcp/`) is an optional second Worker: OAuth 2.1 (workers-oauth-provider + `OAUTH_KV`), stateless `createMcpHandler` tools at `/mcp`, sharing the app's D1 by `database_id`. The app owns all migrations; the worker reads with raw SQL. People sign in through the app: the worker's `/authorize` sends the browser to `/auth/mcp`, the app mints a single-use code for the signed-in user (`POST /api/mcp/connect-code`), and the worker spends it at `/authorize/callback` after an approval click. Its wrangler scripts pass `-c wrangler.jsonc` — required, because the app build's `.wrangler/deploy/config.json` redirect confuses wrangler otherwise. Do not use `McpAgent` for new tools — it's deprecated in the agents SDK; `createMcpHandler` is the current path. What every tool must declare, the discovery routes, and listing the server in a directory are in [mcp.md](mcp.md).

---


