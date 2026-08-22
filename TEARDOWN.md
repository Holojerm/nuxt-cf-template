# TEARDOWN.md — removing what your fork doesn't need

This template ships a complete consumer SaaS: billing, referrals, an optional MCP
worker, file uploads, a blog, a feedback loop, an admin panel. Most forks want a
subset. **Subtraction is a first-class operation here, and it is the operation most
likely to go wrong** — these subsystems are cross-cutting, so deleting a directory and
chasing the type errors leaves you with orphaned columns, dead env vars, legal copy
naming a processor you no longer use, and tests that pass because they no longer run.

Each section below is an **ordered** list. Do them in order; later steps assume earlier
ones. After each section run:

```bash
bun run ci
```

That is the whole verification strategy. `typecheck` catches the dangling imports,
`test` catches the orphaned suites, `seo:check` catches a page that lost its
`publicPage` meta, `design:check` catches a component you gutted, and
`mirror:check` catches comments still pointing at files you deleted.

**Order between sections matters too.** Referrals depend on entitlements, and the MCP
worker depends on both. If you are removing more than one, go: **referrals → MCP worker
→ billing.**

---

## Remove billing entirely (free product, no payments)

The seam is `requireSubscription(event)`. Everything upstream of it is Paddle; every
call site of it is your product asking "may this account use the paid thing." Removing
billing means answering that question a different way — usually "yes, always" — not
deleting the call sites blindly.

**1. Remove referrals first** (they grant entitlements) — see the next section. Skip
only if you already have.

**2. Decide what replaces the gate.** Three honest options, pick one before touching a
file:

| You want | Do this |
| --- | --- |
| Everything free | Delete every `requireSubscription(event)` call, replace with `requireUserSession(event)` |
| Free but sign-in required | Same as above — that *is* what `requireUserSession` means |
| Invite-only / allowlist | Keep the call sites, reimplement `requireSubscription` against your own table |

**3. Rewrite the call sites** (there are four, all in the files feature):

- [`server/api/files/index.get.ts`](server/api/files/index.get.ts)
- [`server/api/files/index.post.ts`](server/api/files/index.post.ts)
- [`server/api/files/[id].get.ts`](server/api/files/[id].get.ts)
- [`server/api/files/[id].delete.ts`](server/api/files/[id].delete.ts)

**4. Delete the Paddle adapter and the entitlement layer:**

```
server/routes/paddle/webhook.post.ts
server/utils/paddle.ts
server/utils/paddle-api.ts
server/utils/paddle-refs.ts
server/utils/billing.ts
server/utils/billing-state.ts
server/utils/billing-notifications.ts
server/utils/entitlements.ts
server/utils/entitlement-view.ts
server/api/billing/entitlement.get.ts
server/api/billing/portal.post.ts
```

**5. Delete the billing UI:**

```
app/composables/usePaddle.ts
app/components/Billing/PastDueAlert.vue
app/components/Billing/PastDueBanner.vue
app/middleware/subscription.ts
app/pages/pricing.vue
app/utils/plans.ts
app/utils/checkout.ts
app/utils/churn.ts
```

Then remove the `PastDueBanner` mount from [`app/layouts/default.vue`](app/layouts/default.vue),
the `['auth', 'subscription']` middleware array in
[`app/pages/dashboard.vue`](app/pages/dashboard.vue) and
[`app/pages/files.vue`](app/pages/files.vue) (leave `'auth'`), and the billing
sections of [`app/pages/account.vue`](app/pages/account.vue) and
[`app/pages/admin/users/[id].vue`](app/pages/admin/users/[id].vue).

**6. `app/utils/faq.ts` and `app/pages/index.vue` reference plans.** `PRICING_FAQ` and
its `FAQPage` JSON-LD describe pricing that no longer exists — delete the entries.
Structured data describing content you do not render is a manual-action risk with
Google, so do not leave it behind "for later."

**7. Drop the schema.** In [`server/db/schema.ts`](server/db/schema.ts) delete the
`entitlements` table, then:

```bash
bun db:generate    # writes the DROP TABLE migration
bun db:migrate     # local
```

Remember production and preview are separate and nothing applies migrations for you:
`bun run db:migrate:remote` and `bun run db:migrate:preview`.

**8. Delete the tests.** `test/paddle.test.ts`, `test/entitlements.test.ts`,
`test/entitlement-view.test.ts`, `test/billing-state.test.ts`,
`test/billing-notifications.test.ts`, `test/checkout.test.ts`, and the three e2e specs
`test/e2e/purchase-access.spec.ts`, `test/e2e/cancel-lose-access.spec.ts`,
`test/e2e/webhook-signing.spec.ts` (plus `test/e2e/webhook-secret.ts`).

**9. Strip the config.** Remove from `.env.example`, `wrangler.toml` (both `[vars]` and
`[env.preview.vars]`), and the `runtimeConfig` block in `nuxt.config.ts`:

```
NUXT_PADDLE_API_KEY
NUXT_PADDLE_WEBHOOK_SECRET
NUXT_PUBLIC_PADDLE_CLIENT_TOKEN
NUXT_PUBLIC_PADDLE_ENV
NUXT_PUBLIC_PADDLE_PRICE_MONTHLY
NUXT_PUBLIC_PADDLE_PRICE_YEARLY
NUXT_PUBLIC_PADDLE_PRICE_PASS
```

Also remove `https://*.paddle.com` from the CSP in `nuxt.config.ts` — `test/csp/csp.spec.ts`
asserts the header, so a stale entry there is a silently over-permissive policy.

**10. Fix the legal copy.** [`app/pages/privacy.vue`](app/pages/privacy.vue) and
[`app/pages/terms.vue`](app/pages/terms.vue) name Paddle as the merchant of record and
as a subprocessor. Leaving that in is a factual misstatement in a legal document —
it is not cosmetic. [`app/utils/changelog.ts`](app/utils/changelog.ts) mentions it too.

**11. Delete emails that no longer have a trigger** — receipt, payment-failed, and
access-ended templates in [`server/utils/email-templates.ts`](server/utils/email-templates.ts),
and their entries in the notification taxonomy in
[`shared/utils/notifications.ts`](shared/utils/notifications.ts). Keep `security.*`
and the welcome mail.

---

## Swap Paddle for Stripe (or Lemon Squeezy, or RevenueCat)

Do **not** start by deleting things. The entitlement model — one row per subscription,
status transitions drive email, refunds and chargebacks cascade a revocation — is
provider-independent and is the part that took the longest to get right. Keep it.

**The adapter boundary is four files.** Everything else reads the `entitlements` table
and does not care who wrote it:

| File | What it does | Stripe equivalent |
| --- | --- | --- |
| [`server/routes/paddle/webhook.post.ts`](server/routes/paddle/webhook.post.ts) | HMAC-verifies, then hands the event to `applyPaddleEvent` | `stripe.webhooks.constructEvent` over the raw body |
| [`server/utils/paddle.ts`](server/utils/paddle.ts) | Classifies a provider event into an entitlement change | Map `customer.subscription.*` / `charge.refunded` / `charge.dispute.*` onto the same verbs |
| [`server/utils/paddle-api.ts`](server/utils/paddle-api.ts) | Server-side calls (the self-serve portal link) | Billing Portal session create |
| [`app/composables/usePaddle.ts`](app/composables/usePaddle.ts) | Opens checkout in the browser | Stripe Checkout redirect or embedded |

**Ordered steps:**

1. **Rename the columns, don't repurpose them.** `entitlements.paddle_subscription_id`
   and `paddle_customer_id` become `provider_subscription_id` / `provider_customer_id`
   via `bun db:generate`. Keep the **unique index** on the subscription id — it is not
   a nicety, it is the entire idempotency mechanism for webhook redelivery.
2. **Reimplement `applyPaddleEvent`** with the same return shape. Read its tests
   (`test/paddle.test.ts`) first and port them — they encode the rules that cost money
   when wrong, particularly that a **partial** refund is not a reversal and that a
   chargeback the merchant later *wins* restores access from `restore_period_end`.
3. **Keep `revokeForAdjustment` and `revokeDerivedEntitlements` untouched.** They live
   in `server/utils/entitlements.ts`, are provider-agnostic, and are what makes a
   refund claw back the referral reward it paid for.
4. **Keep `decideNotification()`** in `server/utils/billing-notifications.ts`. It fires
   on status *transitions*, not events — the reason billing mail here is readable
   rather than noise. Stripe's event stream is at least as chatty as Paddle's.
5. **Re-point the deterministic refs** in `server/utils/paddle-refs.ts`. They are how a
   grant is idempotent without a ledger table; the derivation is yours to change, the
   determinism is not.
6. **Update the CSP** in `nuxt.config.ts`: `js.stripe.com` in `script-src` and
   `frame-src`, Paddle out. `test/csp/csp.spec.ts` will tell you if you missed it.
7. **You are now the merchant of record.** Paddle handled global VAT and sales tax;
   Stripe does not unless you add Stripe Tax, and you take on the registration and
   remittance obligations either way. This is a business decision, not a code one —
   make it deliberately, and update `privacy.vue` / `terms.vue` to match.

---

## Remove referrals

Referrals grant entitlements, so remove them **before** billing.

1. Delete [`server/utils/referral.ts`](server/utils/referral.ts),
   [`server/api/referral/me.get.ts`](server/api/referral/me.get.ts),
   [`shared/utils/referral.ts`](shared/utils/referral.ts),
   [`app/components/Referral/ShareCard.vue`](app/components/Referral/ShareCard.vue),
   and `test/referral.test.ts`.
2. Remove the `ShareCard` mount from [`app/pages/account.vue`](app/pages/account.vue).
3. In [`server/routes/paddle/webhook.post.ts`](server/routes/paddle/webhook.post.ts),
   remove the first-paid hook that calls into the referral module.
4. In [`server/utils/auth.ts`](server/utils/auth.ts), drop the `referred_by`
   resolution from the INSERT branch of `upsertOAuthUser`, and in
   [`server/utils/magic-link.ts`](server/utils/magic-link.ts) drop the
   `referral_code` carried on the token row.
5. In [`shared/utils/attribution.ts`](shared/utils/attribution.ts), remove the `?ref=`
   handling. **Keep the rest of the file** — first-touch UTM attribution is
   independent of referrals and is worth having.
6. Schema ([`server/db/schema.ts`](server/db/schema.ts)): drop `users.referral_code`,
   `users.referred_by` and its index, `entitlements.earned_from_ref`, and the
   `referral_code` column on `magic_link_tokens`. Then `bun db:generate`.
7. **Leave `instance_secrets` and `server/utils/identity.ts` alone.** The salted-hash
   helper is shared with the magic-link per-address rate limit, which is a security
   control. Deleting the table because "referrals used it" removes that too.
8. Remove `REFERRAL_*` from `.env.example`, `wrangler.toml`, and `nuxt.config.ts`.

---

## Remove the optional MCP worker

Nothing in the app depends on it — it is a second Worker that reads the same D1.

1. `rm -rf mcp/`
2. Delete [`server/api/mcp/connect-code.post.ts`](server/api/mcp/connect-code.post.ts).
3. Schema: drop the `mcp_connect_codes` table, then `bun db:generate`.
4. Remove the connect-code sweep from [`server/utils/purge.ts`](server/utils/purge.ts)
   and its case in `test/purge.test.ts`. **Keep the magic-link sweep** — expired tokens
   still need purging.
5. Remove the MCP mirror entry from `MIRRORS` in
   [`scripts/check-mirrors.ts`](scripts/check-mirrors.ts). That entry exists only
   because the worker cannot import the app's TypeScript; with no worker there is no
   second copy to keep honest. Leave the **reference-resolution** half of that script
   in place — it is not MCP-specific.
6. Remove `mcp:dev`, `mcp:typecheck`, `mcp:deploy` from `package.json`.
7. Remove the MCP step from the onboarding checklist in
   [`shared/utils/onboarding.ts`](shared/utils/onboarding.ts) and the connect-code UI in
   [`app/pages/account.vue`](app/pages/account.vue).
8. Delete the `OAUTH_KV` namespace in Cloudflare, and the deployed worker if you shipped it.

> **Not the same thing as `.mcp.json`.** That file configures the MCP servers *Claude
> Code* talks to while you develop. It has nothing to do with `mcp/` and you almost
> certainly want to keep it.

---

## Smaller removals

| Remove | Delete | Also |
| --- | --- | --- |
| **Blog** | `content/`, `content.config.ts`, `server/utils/blog.ts`, `shared/utils/blog.ts`, `server/api/blog/`, `app/pages/blog/`, `test/blog.test.ts` | Drop `@nuxt/content` from `package.json` and `modules` in `nuxt.config.ts`; remove the blog enumeration from `sitemap.xml.get.ts` and `llms.txt.get.ts` |
| **File uploads (R2)** | `server/api/files/`, `server/utils/files.ts`, `shared/utils/files.ts`, `app/pages/files.vue`, `app/components/Upload/FileUpload.vue`, `test/files.test.ts` | Drop the `files` table; remove `blob` from `hub` config in `nuxt.config.ts` and the R2 bucket from `wrangler.toml` |
| **Feedback loop** | `app/components/Feedback/`, `app/composables/useFeedback.ts`, `server/api/feedback*`, `server/utils/feedback.ts`, `app/pages/admin/feedback.vue`, `test/feedback.test.ts` | Drop the `feedback` table; remove the widget from `app/layouts/default.vue` and the public-path allowlist entry in `server/middleware/auth.ts`; delete `.claude/routines/feedback-triage.md` |
| **Image transforms** | `server/utils/images.ts`, `test/images.test.ts` | Remove the transform branch from `server/api/files/[id].get.ts` (leave the `blob.serve()` call), `@nuxt/image` from `package.json` / `modules` / the `image` and `$development` blocks in `nuxt.config.ts`, the `[images]` blocks from `wrangler.toml`, and `.claude/docs/images.md`. Replace every `<NuxtImg>` with `<img>` — a leftover `<NuxtImg>` is a build error, so the typecheck finds them for you |
| **Turnstile** | `server/utils/turnstile.ts`, `test/turnstile.test.ts` | Remove `<NuxtTurnstile>` from `login.vue` and the feedback widget, `@nuxtjs/turnstile` from `package.json`, and `challenges.cloudflare.com` from the CSP. **You are removing a bot control from two endpoints a stranger can reach** — rate limiting alone is weaker |
| **Admin panel** | `app/pages/admin/`, `server/api/admin/`, `server/utils/admin.ts`, `server/utils/admin-grants.ts`, `app/utils/admin.ts`, `test/admin-grants.test.ts` | Keep `server/utils/audit.ts` and the `audit_log` table — deletion and grant history are written from non-admin paths too |
| **PostHog analytics** | `app/plugins/posthog.client.ts`, `server/utils/posthog.ts`, `server/routes/ingest/`, `app/utils/analytics-privacy.ts` | Remove the PostHog CSP entries; the `$exception` branch of `server/plugins/error-logger.ts` (**keep the `console.error` branch** — it is your only error visibility once PostHog is gone) |

---

## Do not remove these

Each one looks optional and is not:

- **`server/middleware/auth.ts`** — the global API guard *and* the auth-surface rate
  limit. The client middleware in `app/middleware/` is UX only; this is the boundary.
- **`server/utils/session-guard.ts`** and `users.sessions_invalid_before` — the only
  mechanism that revokes a sealed-cookie session. Without it "delete my account" leaves
  the user signed in on their other devices.
- **`server/utils/identity.ts`** and the `instance_secrets` row — shared by the
  magic-link per-address rate limit. See the referrals section.
- **`server/utils/log.ts` › `pathForLog()`** — keeps live credentials out of logs on the
  two routes that carry a token in the URL.
- **The `design:check` / `brand:check` / `seo:check` / `mirror:check` gates.** They are
  cheap and they are what stops an AI-assisted codebase drifting apart at feature forty.
  If one is failing, fix the code.
- **`compatibility_flags` in `wrangler.toml`.** `queue_consumer_wait_for_wait_until` is
  load-bearing; without it a queue `retry()` is a silent no-op.

---

## When you're done

```bash
bun run ci
```

Then grep for orphans the type checker cannot see — comments and docs pointing at files
you deleted:

```bash
bun run mirror:check
```

Finally, update [`CLAUDE.md`](CLAUDE.md)'s index table and delete the
`.claude/docs/` file for anything you removed. A doc describing a subsystem your fork no
longer has is worse than no doc: an agent will read it and write code against it.
