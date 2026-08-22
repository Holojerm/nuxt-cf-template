# Provisioning ledger — `my-app`

What is live, what a human did, and what is still open. Written during the
provisioning run of 2026-08-22 against Cloudflare account
`90394168655e3aff5b5f299c4a213f54` (Jeremy.ettlinger@gmail.com).

**Kickoff answers.** Target: the template itself, as a demo deployment (no
`bun run rename`). Domain: none — `*.workers.dev`. Scope: Google OAuth, GitHub
OAuth, preview environment. Accounts already existing: Apple Developer Program,
Resend, PostHog, Paddle.

**Origins.**

| | |
| --- | --- |
| Production | `https://my-app.jeremy-ettlinger.workers.dev` |
| Preview | `https://my-app-preview.jeremy-ettlinger.workers.dev` |

---

## The one thing blocking everything else

`wrangler secret put` is **denied by this session's permission classifier**. That
is not a Cloudflare problem and not a missing credential — the command simply
cannot run from here. Every secret in this template therefore ends as a
hand-over, including the one the agent was otherwise allowed to generate.

The immediate consequence is verified, not theorised. With no
`NUXT_SESSION_PASSWORD`, the deployed Worker logs

```
[nuxt-auth-utils] NUXT_SESSION_PASSWORD environment variable or runtimeConfig.session.password was not set.
```

and **every `/api/*` route returns 500** (the homepage still renders 200,
because the global auth middleware only runs on `/api/`). Run the first command
in [Remaining commands](#remaining-commands) and that clears.

---

## Ledger

| Item | State | Who did it | Where it lives | Verified by | Still needed |
| --- | --- | --- | --- | --- | --- |
| D1 `my-app-db` | `live` | agent | `wrangler.toml` › `database_id = e05a806f-7596-4b97-893c-cb27614bd265` | `wrangler d1 list`; bound in deploy output | — |
| D1 `my-app-db-preview` | `live` | agent | `[env.preview]` › `479e9535-ee44-4e4b-8498-bd524933c814` | same | — |
| Migrations 0000–0012 (prod) | `live` | agent | `server/db/migrations/` | `d1 migrations apply` all ✅; `SELECT name FROM sqlite_master` lists `audit_log`, `entitlements`, `feedback`, `files`, `instance_secrets`, `magic_link_tokens`, `mcp_connect_codes`, `notification_preferences`, `users` | — |
| Migrations 0000–0012 (preview) | `live` | agent | same | identical table list on `my-app-db-preview` | — |
| KV (prod) | `live` | agent | `wrangler.toml` › `id = 110a52465ec94fc2b452a4783c5a4421` | bound in deploy output | — |
| KV (preview) | `live` | agent | `[env.preview]` › `4fdf372d76924e80905aa7fdd2074120` | bound in deploy output | — |
| R2 `my-app-blob` | `live` | **pre-existing** (2026-08-20) | matched by name | `wrangler r2 bucket list` — **not recreated** | — |
| R2 `my-app-blob-preview` | `live` | agent | matched by name | created; bound in deploy output | — |
| Queue `my-app-email` | `live` | agent | matched by name | `wrangler queues list` | — |
| Queue `my-app-email-preview` | `live` | agent | matched by name | `queues list`; producer+consumer shown in deploy output | — |
| Dead-letter queues | `live` | Cloudflare, on deploy | `dead_letter_queue` in `wrangler.toml` | **checked, not assumed**: `my-app-email-preview-dlq` appeared at 21:28:57, after the deploy — the README's claim holds | — |
| Rate limiter 1001 / 1002 | `live` | agent | `[[ratelimits]]` / `[[env.preview.ratelimits]]` | `env.RATE_LIMITER (30 requests/60s)` in both deploy outputs; preview flattens to `1002`, **not** inherited 1001 | — |
| Production Worker | `live` | agent | version `7f37b643-4c55-438c-8d5b-2a35908f68aa` | `curl /` → 200 | secrets below |
| Preview Worker `my-app-preview` | `live` | agent | version `4eca5d75-e5a7-4c48-a45f-8b650c3f76f1` | deploy output; separate name, D1, KV, R2, queue, counters | secrets below |
| Cron trigger `0 4 * * *` | `live` | agent (via deploy) | `[triggers]` | dashboard: "Runs At 04:00 AM / Next Sun, 23 Aug 2026 04:00:00" | — |
| Workers Builds | `configured-unverified` | agent | Worker → Settings → Build | repo `Holojerm/nuxt-cf-template`, branch `main`, build `bun run ci`, deploy `bunx wrangler --cwd .output deploy`, version `bunx wrangler --cwd .output versions upload`, root `/`, non-production builds on | no build has run yet; needs the session-password build variable |
| GitHub App repo access | `live` | agent | github.com/settings/installations | `nuxt-cf-template` added alongside `whonder` + `drawthesystem-cloud`, which were left intact; scope kept at "Only select repositories" | — |
| Turnstile widget `my-app` | `configured-unverified` | agent | site key in `[vars]` + `[env.preview.vars]` | "Successfully created Turnstile widget"; hostnames = both workers.dev hosts; Managed; pre-clearance off | secret key |
| GitHub OAuth app | `configured-unverified` | agent | Client ID `Ov23liQyWvgpxRQ0eLrG` | app page reachable; redirect URIs for prod **and** preview | client secret — **not yet generated**, see below |
| Google Cloud project | `live` | agent | `my-app-506322` | project switcher shows "My App" | — |
| Google Auth Platform | `live` | agent (**you approved the policy**) | project `my-app-506322` | wizard completed: app "My App", audience **External**, contact jeremy.ettlinger@gmail.com | test users, see caveats |
| Google OAuth client | `configured-unverified` | agent | Client ID `546642789466-be7tki166137t2khk32o3tqjkkkcqe99.apps.googleusercontent.com` | "OAuth client created", Status Enabled | client secret |
| Paddle webhook destination | `configured-unverified` | agent | sandbox → Notifications | Active, **12 events** = 9 × `subscription.*` + `transaction.completed` + `adjustment.created` + `adjustment.updated`, exactly what `webhook.post.ts` documents | webhook secret, API key, price IDs |
| PostHog project key | `configured-unverified` | agent | `[vars]` › `NUXT_PUBLIC_POSTHOG_KEY` | project 569675, US region — matches `posthogHost` default | app must be reachable to verify ingestion |
| PostHog feature flags | `skipped` | owner's choice at kickoff | — | — | `new-onboarding`, `pricing-layout` (`control` \| `pass-first`) stay non-existent; code returns control for both |
| Resend | `blocked` | — | — | — | 1Password is **not connected to Claude** (`not_connected`); sign-in never happened |
| Sign in with Apple | `skipped` | owner's choice at kickoff | — | — | also impossible on `*.workers.dev` — Apple will not accept it as a verifiable domain |
| Every secret | `blocked` | — | — | — | see below — `wrangler secret put` is denied in this session |

---

## Remaining commands

Copy-paste order. The first one is the one that matters: it turns every `/api/*`
500 into a working route.

```bash
openssl rand -base64 32 | bunx wrangler secret put NUXT_SESSION_PASSWORD
```

```bash
openssl rand -base64 32 | bunx wrangler secret put NUXT_SESSION_PASSWORD --env preview
```

```bash
bunx wrangler secret put NUXT_TURNSTILE_SECRET_KEY
```

```bash
bunx wrangler secret put NUXT_TURNSTILE_SECRET_KEY --env preview
```

```bash
bunx wrangler secret put NUXT_OAUTH_GOOGLE_CLIENT_ID
```

```bash
bunx wrangler secret put NUXT_OAUTH_GOOGLE_CLIENT_SECRET
```

```bash
bunx wrangler secret put NUXT_OAUTH_GITHUB_CLIENT_ID
```

```bash
bunx wrangler secret put NUXT_OAUTH_GITHUB_CLIENT_SECRET
```

```bash
bunx wrangler secret put NUXT_PADDLE_WEBHOOK_SECRET
```

```bash
bunx wrangler secret put NUXT_PADDLE_API_KEY
```

```bash
bunx wrangler secret put NUXT_RESEND_API_KEY
```

```bash
bunx wrangler secret put NUXT_RESEND_FROM
```

Where each value comes from:

| Secret | Source |
| --- | --- |
| `NUXT_SESSION_PASSWORD` | generated by the command itself; never printed |
| `NUXT_TURNSTILE_SECRET_KEY` | dash → Turnstile → `my-app` → Settings. The agent saw it and deliberately did not record it. |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` | `546642789466-be7tki166137t2khk32o3tqjkkkcqe99.apps.googleusercontent.com` (not secret; kept here so you needn't look it up) |
| `NUXT_OAUTH_GOOGLE_CLIENT_SECRET` | the "OAuth client created" dialog, still open in your browser. If you closed it: Google Auth Platform → Clients → the client → download the JSON. |
| `NUXT_OAUTH_GITHUB_CLIENT_ID` | `Ov23liQyWvgpxRQ0eLrG` (not secret) |
| `NUXT_OAUTH_GITHUB_CLIENT_SECRET` | github.com/settings/applications/3809872 → **Generate a new client secret**. The agent left this ungenerated on purpose so the value is shown only to you. |
| `NUXT_PADDLE_WEBHOOK_SECRET` | Paddle sandbox → Notifications → the `my-app` destination → its signing secret |
| `NUXT_PADDLE_API_KEY` | Paddle sandbox → Developer tools → Authentication (only needed for the customer-portal link) |
| `NUXT_RESEND_API_KEY` | resend.com/api-keys — **create a sending-only key** |
| `NUXT_RESEND_FROM` | with no verified domain, the only value that works is `My App <onboarding@resend.dev>` — see caveats |

Also **in the Cloudflare dashboard**, Worker → Settings → Build → Variables and
secrets: add `NUXT_SESSION_PASSWORD` as a build variable marked **secret**, or
`bun run ci` runs without it in CI.

---

## Caveats you should know about

**1. `bun run db:migrate:preview` was broken, and is fixed in this PR.** It ran
`wrangler d1 migrations apply my-app-db-preview --remote` with no `--env preview`,
so wrangler looked for that database in the top-level config, where it does not
exist, and failed with *"Couldn't find a D1 DB with the name or binding
'my-app-db-preview' in your wrangler.toml file."* The README documents this
command as the way to migrate preview. Now `--env preview`.

**2. `CLOUDFLARE_ENV=preview` cannot be scoped the way the README says.** The
README instructs adding it "on the non-production branch trigger only". In
today's Workers Builds UI a Worker has **one flat list** of build variables that
applies to every build — there is no per-trigger scoping (that exists for Pages
projects, not Workers). Setting it there would make **production** builds emit
preview bindings onto the production Worker, which is precisely the disaster the
template's own comments warn about. So it is deliberately **not set**, and the
consequence is the documented default: a non-production branch build uploads a
version of the *production* Worker carrying *production* bindings.

The clean fix, which is a design change and so was not made unilaterally:
connect Workers Builds a **second time** on the `my-app-preview` Worker, pointed
at the same repo, with `CLOUDFLARE_ENV=preview` as *its* build variable, and turn
**off** non-production branch builds on `my-app`. Then each Worker's builds carry
exactly one environment and nothing has to be scoped per trigger.

**3. Turnstile Spin does not work from an automated browser.** You asked for
Spin. Both "Set up with Spin" buttons are inert, `/turnstile/spin` renders blank,
and no console error is raised — it appears to hand off somewhere the automated
tab group cannot follow. With your go-ahead the widget was created through "Add
widget manually", which yields the identical artifact. No loss: Spin's value is
having an agent wire `siteverify` into the backend, and this app already does
that correctly — the challenge runs *before* the per-address rate limit (so an
unsolved bot cannot burn a victim's budget) and it fails **closed**.

**4. The Turnstile site key is committed but its secret is not set.** That is the
"one bad state" `server/utils/turnstile.ts` logs as `turnstile_half_configured`:
the widget renders and nothing verifies it. **Set `NUXT_TURNSTILE_SECRET_KEY`
before merging this PR.** The comment above the key in `wrangler.toml` says the
same thing.

**5. Google sign-in is in testing mode.** External audience on an unverified app
means only accounts listed as **test users** on the consent screen can sign in —
everyone else gets `access_denied`. Add yourself at Google Auth Platform →
Audience → Test users before trying it, and publish the app when you want real
users.

**6. Resend cannot send to anyone but you.** There is no custom domain, so the
only usable sender is Resend's shared `onboarding@resend.dev`, which Resend
delivers **only to the address that owns the account**. Magic-link sign-in will
work for you and fail for every other person. This is fine for a demo and wrong
for anything real — the fix is a domain, its DKIM/SPF records, and a
sending-only key scoped to it.

**7. PostHog is deliberately absent from the preview environment.** The key is in
`[vars]` only. Preview shares the same PostHog project, and adding it there would
mix branch traffic into production analytics. Unset means the plugin no-ops,
which is the right default.

**8. Nothing was verified end-to-end through the app.** Providers, Turnstile,
magic-link, `/ingest`, and the Paddle handler all sit behind `/api/*`, which
500s until the session password is set. Everything marked
`configured-unverified` above is *configured correctly and unproven*; none of it
was marked `live` on the strength of a dashboard screenshot alone.

**9. A pending permission-update request from Cloudflare's GitHub App was left
alone.** github.com/settings/installations shows "Permission updates requested"
for Cloudflare Workers and Pages (and for Claude, and Fleek.co). Only repository
*access* was changed — reviewing a permissions escalation is yours to do.

---

## Verify it worked

After the session password is set:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://my-app.jeremy-ettlinger.workers.dev/api/health
```

```bash
curl -s https://my-app.jeremy-ettlinger.workers.dev/api/auth/providers
```

Both should stop returning 500. `providers` should list `google` and `github`
once their four secrets are set, and `/login` should render the Turnstile widget
once its site key ships with a matching secret.
