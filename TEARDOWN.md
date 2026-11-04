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

The seam is `requireAccess(event)` ([`server/utils/access-gate.ts`](server/utils/access-gate.ts)),
which every paywalled route calls (the files layer's four routes today). Billing registers
the real check, `requireSubscription`; with nothing registered it falls back to a stand-in
that is just `requireUserSession(event)`: free, but sign-in required. Removing billing
therefore means choosing what *replaces* the gate, not deleting call sites.

**1. Remove referrals first** (they grant entitlements) — see the next section. Skip
only if you already have.

**2. Decide what replaces the gate.** Three honest options, pick one before touching a
file:

| You want | Do this |
| --- | --- |
| Everything free | Nothing: with billing gone `requireAccess` is the stand-in, `requireUserSession` |
| Free but sign-in required | Same: that *is* the stand-in |
| Invite-only / allowlist | `registerAccessGate(fn)` from a Nitro plugin, with your own check; routes keep calling `requireAccess` |

**3. Call sites** need no edit, including the files layer's (vendored copies are never
edited): they call `requireAccess`. Your own paywalled routes should too; if they call
`requireSubscription` directly, switch them. The client-side `subscription` route
middleware is billing's; the files page and `app/pages/dashboard.vue` name it, so add a
no-op `subscription` route middleware in the app's `app/middleware/` (or shadow those pages) unless you edit them.

**4. Delete the layer.** Billing is `layers/billing/`: don't vendor it, or `rm -rf` it. It holds
the Paddle adapter (webhook, signature check, portal call), the entitlement model and its
tests, billing state and notifications, comp grants, the `/pricing` page with `plans.ts`,
the `usePaddle` and `useEntitlement` composables, the past-due banner and alert, the `subscription` route
middleware, the replay fixtures, and the Nitro plugin inside it that registers billing
with core. Referrals are a separate layer (`layers/referral/`); step 1 removes them.

Core imports none of it, so nothing else in core needs editing: account deletion is
unguarded (and cancels nothing at Paddle), the data export drops `entitlements`, `/api/fleet` drops its `entitlements` group
and reports `funnel.paid` as 0, the lifecycle run drops `pass_expiring`, the nightly purge
drops the `paddleEvents` sweep, and `shared/utils/onboarding-steps.ts` loses its
`entitlementActive` input (drop the `plan` step there). In a fork that vendored the layer,
remove its entry from `layers.lock.json` too.

This claim is a gate, not a promise: `bun run ci:forkless` copies the template, deletes the
billing and referral layers and the schema line in step 7, adds the no-op middleware from step 3,
and runs `layers:check`, `mirror:check`, the unit tests, the Playwright listing and a typecheck on
the result. The only type errors it allows are in the files step 5 names. No `refs-check-ignore`,
stub file or edited template script is needed, so if you find yourself adding one, the template has
a bug: report it upstream.

**5. Remove what the app still says about billing.** The `PastDueBanner` mount in
[`app/layouts/default.vue`](app/layouts/default.vue), `useEntitlement()` in
[`app/components/Auth/UserMenu.vue`](app/components/Auth/UserMenu.vue), the
`['auth', 'subscription']` middleware array in
[`app/pages/dashboard.vue`](app/pages/dashboard.vue) and
[`layers/files/app/pages/files.vue`](layers/files/app/pages/files.vue) (leave `'auth'`), the plan list on
[`app/pages/index.vue`](app/pages/index.vue), and the billing sections of
[`app/pages/account.vue`](app/pages/account.vue) and
[`app/pages/admin/users/[id].vue`](app/pages/admin/users/[id].vue). `bun run typecheck` lists
every spot.

**6. `app/utils/faq.ts` and `app/pages/index.vue` reference plans.** `PRICING_FAQ` and
its `FAQPage` JSON-LD describe pricing that no longer exists — delete the entries.
Structured data describing content you do not render is a manual-action risk with
Google, so do not leave it behind "for later."

**7. Drop the schema.** In [`server/db/schema.ts`](server/db/schema.ts) delete the
`export * from '../../layers/billing/server/db/schema'` line (that drops `entitlements` and
`paddle_events`), then:

```bash
bun db:generate    # writes the DROP TABLE migration
bun db:migrate     # local
```

Remember production and preview are separate and nothing applies migrations for you:
`bun run db:migrate:remote` and `bun run db:migrate:preview`.

**8. The e2e specs left with the layer.** Billing's browser specs, fixtures and Paddle
environment are `layers/billing/test/e2e/`; `playwright.config.ts` finds them there, so with the
layer gone the `e2e-billing` project, the webhook secret and price ids on the dev server, and the
webhook warm-up are gone too, and nothing needs deleting. The a11y and CSP specs follow the layer
the same way: no `/pricing` scan, and the CSP spec instead asserts that no Paddle host is left in
the policy, which is what step 9's `nuxt.config.ts` edit is checked against.

**9. Strip the config.** The `runtimeConfig` declarations went with the layer. Remove from
`.env.example` and `wrangler.toml` (both `[vars]` and `[env.preview.vars]`), and any
product-id or `NUXT_BILLING_*` variable you set:

```
NUXT_PADDLE_API_KEY
NUXT_PADDLE_WEBHOOK_SECRET
NUXT_PUBLIC_PADDLE_CLIENT_TOKEN
NUXT_PUBLIC_PADDLE_ENV
NUXT_PUBLIC_PADDLE_PRICE_MONTHLY
NUXT_PUBLIC_PADDLE_PRICE_PASS
```

Also remove `https://*.paddle.com` from the CSP in `nuxt.config.ts` — `test/csp/csp.spec.ts`
asserts the header, so a stale entry there is a silently over-permissive policy.

**10. Fix the legal copy.** [`app/pages/privacy.vue`](app/pages/privacy.vue) and
[`app/pages/terms.vue`](app/pages/terms.vue) name Paddle as the merchant of record and
as a subprocessor. Leaving that in is a factual misstatement in a legal document —
it is not cosmetic. [`app/utils/changelog.ts`](app/utils/changelog.ts) mentions it too.

**11. Delete emails that no longer have a trigger** — the receipt, payment-failed, and
access-ended functions in [`server/utils/email-templates.ts`](server/utils/email-templates.ts),
their `emails/templates/` files (`purchase`, `payment-failed`, `access-ended`, each a `.vue` and
a `.txt`) and their `emails/samples.ts` entries, then `bun run email:build` and fix the
`ACTION_URL` table in `test/emails.test.ts`. Delete their entries in the notification
taxonomy in [`shared/utils/notifications.ts`](shared/utils/notifications.ts). Keep `security.*`
and the welcome mail.

The same applies to tearing out *all* transactional email: delete the template files you no
longer send and rebuild. **Keep** `server/utils/render-email.ts`, `emails/components/`,
`emails/theme.generated.css`, `server/emails/generated.ts` and `emails/templates/ops-digest.*` — the
ops alert digest ([`server/utils/ops-digest.ts`](server/utils/ops-digest.ts)) renders through
them, and it imports nothing else from the email stack.

---

## Swap Paddle for Stripe (or Lemon Squeezy, or RevenueCat)

Do **not** start by deleting things. The entitlement model — one row per subscription,
status transitions drive email, refunds and chargebacks cascade a revocation — is
provider-independent and is the part that took the longest to get right. Keep it.

**The adapter boundary is four files**, all inside `layers/billing/`. A fork that vendors the
layer cannot edit them (`layers:check` fails): drop the layer from `layers.lock.json` and own the
directory as a fork-owned layer before you start. Everything else reads the `entitlements` table
and does not care who wrote it:

| File | What it does | Stripe equivalent |
| --- | --- | --- |
| [`layers/billing/server/routes/paddle/webhook.post.ts`](layers/billing/server/routes/paddle/webhook.post.ts) | HMAC-verifies, then hands the event to `applyPaddleEvent` | `stripe.webhooks.constructEvent` over the raw body |
| [`layers/billing/server/utils/paddle.ts`](layers/billing/server/utils/paddle.ts) | Classifies a provider event into an entitlement change | Map `customer.subscription.*` / `charge.refunded` / `charge.dispute.*` onto the same verbs |
| [`layers/billing/server/utils/paddle-api.ts`](layers/billing/server/utils/paddle-api.ts) | Server-side calls (the self-serve portal link) | Billing Portal session create |
| [`layers/billing/app/composables/usePaddle.ts`](layers/billing/app/composables/usePaddle.ts) | Opens checkout in the browser | Stripe Checkout redirect or embedded |

**Ordered steps:**

1. **Rename the columns, don't repurpose them.** `entitlements.paddle_subscription_id`
   and `paddle_customer_id` become `provider_subscription_id` / `provider_customer_id`
   via `bun db:generate`. Keep the **unique index** on the subscription id — it is not
   a nicety, it is the entire idempotency mechanism for webhook redelivery.
2. **Reimplement `applyPaddleEvent`** with the same return shape. Read its tests
   (`layers/billing/test/paddle.test.ts`) first and port them — they encode the rules that cost money
   when wrong, particularly that **any** approved refund ends the buyer's access, and
   that a chargeback the merchant later *wins* restores access — the buyer's one-off
   pass and the referral reward it earned — from `restore_period_end`.
3. **Keep `revokeForAdjustment` and `revokeDerivedEntitlements` untouched.** They live
   in `layers/billing/server/utils/entitlements.ts`, are provider-agnostic, and are what makes a
   refund claw back the referral reward it paid for.
4. **Keep `layers/billing/server/utils/billing-notifications.ts` › `decideNotification`.** It fires
   on status *transitions*, not events — the reason billing mail here is readable
   rather than noise. Stripe's event stream is at least as chatty as Paddle's.
5. **Re-point the deterministic refs** in `layers/billing/server/utils/paddle-refs.ts`. They are how a
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

Referrals are `layers/referral/`, and they grant entitlements, so remove them **before**
billing (billing itself never imports them, but the loop is what pays its rewards).

1. **Delete the layer**: don't vendor it, or `rm -rf layers/referral`. (`bun run ci:forkless` builds
   a fork without it and runs the gates.) That one directory is
   the loop: the policy and its tests, the code per account, the welcome days, the reward and
   the clawback's paperwork, `referral`/`referralKind` on the billing view,
   `GET /api/referral/me`, the share card, and the Nitro plugin that registers it all with
   core. Core and billing import none of it, so sign-in, the webhook and the entitlement view
   run without it: an account is created with no code and no referrer, nothing is paid on a
   first purchase, and the billing view has no referral fields. In a fork that vendored it,
   remove its entry from `layers.lock.json` too.
2. Remove the `ShareCard` mount from [`app/pages/account.vue`](app/pages/account.vue), and
   the `referral` / `referralKind` branches of its billing card and history list (and of
   [`app/pages/admin/users/[id].vue`](app/pages/admin/users/[id].vue)), and the
   `REFERRAL_STACKING_NOTE` line: those fields and that constant exist only while the layer
   provides them. `bun run typecheck` finds each.
3. Optional: the first-touch cookie carries a `?ref=` claim
   ([`shared/utils/attribution.ts`](shared/utils/attribution.ts)) and a magic link carries it
   on its token row ([`server/utils/magic-link.ts`](server/utils/magic-link.ts)). With no
   signup contributor registered the claim is read and ignored, which is harmless. To remove
   it, drop the `referralCode` field and its code-shape import (and
   `shared/utils/referral-code.ts`), and the `referral_code` carried on the token row.
   **Keep the rest of the attribution file** — first-touch UTM attribution is independent of
   referrals and is worth having.
4. Schema ([`server/db/schema.ts`](server/db/schema.ts)): drop `users.referral_code`,
   `users.referred_by` and its index, and the `referral_code` column on `magic_link_tokens`.
   `entitlements.earned_from_ref` belongs to billing (it keys the refund cascade) and stays.
   Then `bun db:generate`. (The layer has no tables of its own.)
5. Admin audit labels (`referral.rewarded`, `referral.revoked`, `referral.restored`) live in
   [`server/utils/audit.ts`](server/utils/audit.ts): keep them, history rows may name them.
6. **Leave `instance_secrets` and `server/utils/identity.ts` alone.** The salted-hash
   helper is shared with the magic-link per-address rate limit, which is a security
   control. Deleting the table because "referrals used it" removes that too.

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

> **Not the same thing as `.mcp.json.example`.** That file configures the MCP servers *Claude
> Code* talks to while you develop. It has nothing to do with `mcp/` and you almost
> certainly want to keep it.

---

## Smaller removals

| Remove | Delete | Also |
| --- | --- | --- |
| **Blog** | `content/`, `content.config.ts`, `server/utils/blog.ts`, `server/utils/blog-routes.ts`, `server/plugins/blog-routes.ts`, `shared/utils/blog.ts`, `server/api/blog/`, `app/pages/blog/`, `test/blog.test.ts` | Drop `@nuxt/content` from `package.json` and `modules` in `nuxt.config.ts`; remove the blog enumeration from `sitemap.xml.get.ts` and `llms.txt.get.ts` |
| **File uploads (R2)** | `layers/files/` (also holds the image transforms) | Delete its `export *` line at the end of `server/db/schema.ts` and run `bun run db:generate` to drop the `files` table; remove `blob` from `hub` config in `nuxt.config.ts` and the R2 bucket from `wrangler.toml`. Account deletion and the nightly purge drop their upload sweeps on their own |
| **Feedback loop** | `layers/feedback/` | Delete its `export *` line at the end of `server/db/schema.ts` and run `bun run db:generate` to drop the table; remove `<FeedbackWidget />` from `app/layouts/default.vue` and `app/components/Onboarding/Checklist.vue`, `<FeedbackAdminUserCard>` from `app/pages/admin/users/[id].vue`, the cancel-reason `useFeedback()` call in `app/pages/account.vue`, the step from `shared/utils/onboarding-steps.ts`, `registerFeedbackExtensions()` from `test/onboarding-activation.test.ts`; delete `.claude/routines/feedback-triage.md`. Account export/deletion, the admin user view and `/api/fleet` drop their feedback sections on their own |
| **Social posting (Buffer)** | `layers/social/` | Delete its `export *` line at the end of `server/db/schema.ts` and run `bun run db:generate` to drop the `social_posts` table; remove `social:post` from `SCHEDULED_TASKS` in `nuxt.config.ts` if the app scheduled it, and the `NUXT_SOCIAL_*` secrets |
| **Image transforms** | `layers/files/server/utils/images.ts`, `layers/files/test/images.test.ts` | Remove the transform branch from `layers/files/server/api/files/[id].get.ts` (leave the `blob.serve()` call), `@nuxt/image` from `package.json` / `modules` / the `image` and `$development` blocks in `nuxt.config.ts`, the `[images]` blocks from `wrangler.toml`, and `.claude/docs/images.md`. Replace every `<NuxtImg>` with `<img>` — a leftover `<NuxtImg>` is a build error, so the typecheck finds them for you |
| **Lifecycle email** | `server/utils/lifecycle.ts`, `lifecycle-steps.ts`, `lifecycle-emails.ts`, `lifecycle-app-steps.ts`, `server/tasks/lifecycle-email.ts`, `test/lifecycle.test.ts` | Drop `'lifecycle-email'` from the `'0 4 * * *'` entry of `SCHEDULED_TASKS` in `nuxt.config.ts` (`bun run crons:check` verifies the rest) and the "Lifecycle email" section of `.claude/docs/email.md`. Core compiles without them: the `LifecycleStep` type that `registerLifecycleStep()` names lives in `server/types/extension-types.ts`, so no stub `lifecycle.ts` is needed. Billing's `pass_expiring` step needs the runner: remove billing too, or keep these files |
| **Turnstile** | `server/utils/turnstile.ts`, `test/turnstile.test.ts` | Remove `<NuxtTurnstile>` from `login.vue` and the feedback widget, `@nuxtjs/turnstile` from `package.json`, and `challenges.cloudflare.com` from the CSP. **You are removing a bot control from two endpoints a stranger can reach** — rate limiting alone is weaker |
| **Admin panel** | `app/pages/admin/`, `server/api/admin/`, `server/utils/admin.ts`, `app/utils/admin.ts`, and the layer's comp-grant routes (`layers/billing/server/api/admin/`), `layers/billing/server/utils/admin-grants.ts` and `layers/billing/test/admin-grants.test.ts` | Keep `server/utils/audit.ts` and the `audit_log` table — deletion and grant history are written from non-admin paths too |
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

Finally, update [`AGENTS.md`](AGENTS.md)'s index table and delete the
`.claude/docs/` file for anything you removed. A doc describing a subsystem your fork no
longer has is worse than no doc: an agent will read it and write code against it.
