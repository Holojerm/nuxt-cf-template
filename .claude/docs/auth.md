# Auth, sessions, rate limiting, bot protection

Magic-link sign-in, OAuth providers, session revocation, the `rateLimit()` two-backend contract, and Turnstile. Several rules here are load-bearing security invariants — breaking one is a login bypass or an account-enumeration oracle, not a style regression.

> **Load this when:** touching anything under `server/api/auth/`, `server/utils/magic-link.ts`, `server/utils/rate-limit.ts`, `server/utils/turnstile.ts`, session handling, or adding an OAuth provider.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Auth Patterns

<!-- forkless:magic-link:start -->
Sign-in is **implemented**, not scaffolded. The primary path is a **magic link**
(`server/api/auth/magic-link.post.ts` → `/auth/verify` → `verify.post.ts`); Apple,
Google, and GitHub OAuth sit under it at `server/api/auth/<provider>.get.ts`;
users are provisioned on first login by `upsertOAuthUser()`; and a dev-only email
shortcut lets a fresh clone reach a gated page without registering anything.

Three rules the magic-link flow depends on, each of which is a real bug if broken:

- **A GET never spends a token.** Mail security gateways prefetch every URL in an
  incoming message, so a link that signs you in by being fetched signs the scanner
  in. `GET /api/auth/magic-link/verify` only reports whether a token is usable;
  the POST behind the button on `/auth/verify` is what consumes it.
- **Redemption is one atomic statement** — `UPDATE … WHERE used_at IS NULL AND
  expires_at > now RETURNING *` (`server/utils/magic-link.ts`). Read-then-write is a
  login bypass with a race in it: two requests carrying one token would both win.
- **The request endpoint answers identically for an unknown address**, or it is an
  account-enumeration oracle. Its per-address rate limit is what stops it being a
  mail cannon pointed at someone else's inbox.
- **Reserved addresses are refused at mint time.** Deletion anonymizes the `users`
  row and keys it `deleted-<id>@deleted.invalid`, so a link for that tombstone
  would redeem into the deleted account. `isUndeliverableAddress()` refuses the
  `.invalid` TLD. The sign-in email is `security.sign_in_link`, which the
  taxonomy classifies as mandatory, so it can never carry List-Unsubscribe.
- **The token rides in the URL fragment**, never the query string. A fragment is
  never transmitted, so it reaches no access log, no `Referer`, and no proxy —
  which matters because PostHog autocapture attaches `location.href` to every
  event. `app/utils/analytics-privacy.ts` scrubs whatever gets past that.
- **Nothing about the address is observable from outside.** The per-mailbox
  budget is charged inside `createMagicLinkToken()` rather than by `rateLimit()`,
  because the wrapper's `X-RateLimit-Remaining` header and 429 would each answer
  "is this stranger mid-sign-in?" to anyone who POSTs their address. Exhaustion, a
  reserved address, and a provider-rejected send all return the same `{ ok: true }`.
- **The per-mailbox budget is counted in D1, in the same batch as the token
  insert.** `MAGIC_LINK_RATE_LIMIT` is 5 per 15 minutes per canonical mailbox
  (`magic_link_tokens.mailbox`, from `canonicalizeEmailForLimiting()`, so
  `victim+1@gmail.com` … `+9999` are one bucket). D1 serialises the batches, so N
  parallel requests for one mailbox get exactly five mails — the KV fixed window
  it replaced was get-then-set and let every parallel request through, and the
  native binding cannot express a 15-minute window and counts per colo. The row
  is the charge: an over-budget request still writes its token row (nobody holds
  the token; it expires with the rest) and skips the mail.

GitHub ships **unconfigured on purpose** — it is a developer credential, and a
consumer sign-in page that leads with it tells most visitors the product isn't for
them. Configure it for a devtool fork; it renders last either way
(`server/api/auth/providers.get.ts`).
<!-- forkless:magic-link:end -->

```typescript
// Protect a page client-side (UX only — see the warning below)
definePageMeta({ middleware: 'auth' })
definePageMeta({ middleware: ['auth', 'subscription'] }) // signed in AND paying

// Access session in a page
const { loggedIn, user } = useUserSession()

// Protect a server route — THIS is the real boundary
const session = await getUserSession(event)
if (!session.user) throw createError({ statusCode: 401 })

// Or, for anything paid:
const { user, entitlement } = await requireSubscription(event) // 401 | 402
```

**The client middleware is not a security boundary.** `app/middleware/auth.ts`
and `layers/billing/app/middleware/subscription.ts` run in the browser and exist so people see
a login page instead of an empty one. Every paid API route must call
`requireSubscription(event)` itself, or the gate is decorative.

**Sessions are revocable.** A sealed cookie has no server-side record, so
revocation needs both halves: every session carries `issuedAt`, and
`users.sessions_invalid_before` is the watermark that kills everything older.
`server/middleware/auth.ts` checks it on every `/api/*` request that carries a
session — one indexed read, deliberately uncached (`server/utils/session-guard.ts`
explains why a cache would reintroduce the bug). Deletion sets the watermark;
that is what makes "delete my account" end the session on the user's other
devices instead of only the one they clicked from. "Sign out everywhere" on
/account (`POST /api/account/sessions/revoke` → `revokeSessions()`) sets it too,
then re-issues the caller's own cookie from the same clock reading — the
watermark is stored in seconds and the guard is a strict less-than, so the
re-issued session survives and every other device's does not. Anything else
that must invalidate sessions sets the same column — do not add a second
mechanism.
The watermark is the per-user lever; `runtimeConfig.session.maxAge` in
`nuxt.config.ts` (30 days) is the ceiling on every session regardless, so a
leaked cookie cannot outlive it.

**Identity is a provider account first, then the verified email address.**
`establishSession()` runs every sign-in through `signInOAuthUser()`
(`server/utils/oauth-sign-in.ts`), in this order:

1. `(provider, subject)` in `user_identities` → that account, whatever address
   the provider reports this time.
2. A verified email matching an account → that account, and the identity is
   recorded on it.
3. A verified email matching nothing → a new account, identity recorded.

An unverified or missing address never reaches 2 or 3, so it can neither match
nor create an account. Every caller passes an explicit `emailVerified`; never
default it to `true` when adding a provider. Magic link (and the credentials
layer) carry no `subject`, so they are step 2 and 3 only: their identity is the
email, and the magic-link token coming back is our own evidence the address is
theirs. Account deletion deletes the `user_identities` rows in its batch (the
`users` row is kept as a tombstone, so the FK cascade never fires), and the
export lists them as `signInMethods`.

<!-- forkless:oauth:start -->
Which claim counts as verified, per provider:

| Provider | `subject` | Verified when |
| --- | --- | --- |
| Google | `sub` | userinfo `email_verified === true` |
| Apple | id_token `sub` | id_token `email_verified` is `true` or `"true"`. A Hide My Email relay address is verified too, so it can create an account, but it only matches an account that already holds that relay address. |
| GitHub | numeric `id` (never `login`, which can be renamed and re-claimed) | the primary address from `/user/emails` with `verified`, or the public profile address (which GitHub requires to be verified) |

**Linking another sign-in method.** A signed-in person adds a provider from
/account (`app/components/Account/SignInMethods.vue`). `POST
/api/account/identities/link` (session required) sets the `identity-link`
cookie: the session's user id, the provider and the session's `issuedAt`,
HMAC-signed with `sessionPassword`, ten minutes, HttpOnly, `SameSite=None`,
`Path=/api/auth/`. It has to be `None`: Apple's callback is a cross-site form
POST, which carries neither the Lax session cookie nor a Lax intent. The
callback (`finishOAuth()` in `server/utils/oauth-callback.ts`) reads and
deletes it and attaches the provider account to the user it names, never to an
account found by email. What makes a cross-site callback useless is
nuxt-auth-utils' OAuth `state` check, not the cookie: a forged callback has no
code with a `state` matching this browser's HttpOnly `nuxt-auth-state`.

- Refused, with a plain message on /account, if the provider account already
  signs in to another account (`?link_error=taken`). Nothing is merged or moved.
- Refused (`/login?error=link_session_expired`) if the starting session was
  revoked or the account deleted since (`checkSession()`), or if the callback
  arrives with a different session user.
- Voided by sign-out, and by any plain sign-in starting in the same browser
  (`withLinkAwareStart()`), so an abandoned link cannot catch the next person.
- No unlink. A provider whose address matches the account would be re-linked by
  its next sign-in anyway, and the case where unlinking means something (a
  hidden Apple address) is the one where it can lock the person out.

Adding a provider is three steps: add the `oauth.<name>` keys to
`nuxt.config.ts`, write `server/api/auth/<name>.get.ts` mapping the provider's
user shape onto `OAuthProfile` (with its stable `subject`) and ending in
`finishOAuth()` / `failOAuth()`, wrapped in `withLinkAwareStart()`, and add a row to
`server/utils/auth-providers.ts` so `/login` and /account render the button.
(Apple is the exception to step two twice over: its callback is a cross-site
form POST, so that route is `apple.ts` with no method suffix, and it needs
`NUXT_OAUTH_APPLE_REDIRECT_URL` because its handler does not fall back to the
request origin the way the others do.)
<!-- forkless:oauth:end -->

**Never put a secret in a URL a browser will keep.** Two flows here have to hand
someone a credential in a link — the sign-in link and the unsubscribe link — and
three places will happily record it: Cloudflare Logs (`event.path` includes the
query; use `pathForLog()`), the `Referer` the `/ingest` proxy forwards to
PostHog, and PostHog autocapture, which attaches `location.href` to every event.
Put the token in the **fragment** where possible, and scrub the rest through
`app/utils/analytics-privacy.ts`. Analytics access is handed out far more freely
than database access, which is exactly why nothing secret may travel there.

## Public API surface

`server/middleware/auth.ts` 401s every `/api/*` request without a valid session
except the allowlist in `server/utils/public-routes.ts`. Core ships:

- `/api/health` — liveness, public.
- `/api/auth/*`, `/api/_auth/*` — sign-in start, OAuth callbacks, the session
  endpoint `useUserSession()` reads. No session exists yet on these.
- `/api/status`, `/api/fleet` — for the portfolio dashboard. Both run
  `requireFleetToken()`: **404** when `NUXT_FLEET_TOKEN` is unset, **401** on a
  bad bearer. `/api/status` carries the build sha, migration tags and cron
  schedules — a deployment fingerprint, hence the token.
- `GET /api/fleet/feedback` — the feedback queue for the dashboard, same bearer;
  registered by the feedback layer, so removing the layer removes it.
- `GET /api/ops/events` — the ops spool for the `ops-triage` routine, behind its own bearer
  (`NUXT_OPS_TOKEN`) through the same `requireFleetToken()`: 404 unset, 401 wrong.
- `/api/_nuxt_icon/*` — `@nuxt/icon`'s endpoint, called by the browser for any
  icon the client bundle missed; static icon JSON.
- `GET /api/blog`, `GET /api/blog/*` — the blog is public content; registered by
  `server/plugins/blog-routes.ts`, not core, so deleting the blog removes them.
- `GET|POST /api/email/unsubscribe` — reached from a mail footer on a device
  that may not be signed in.
- `POST /api/email/updates`, `POST /api/email/updates/confirm`,
  `GET|POST /api/email/updates/unsubscribe` — the product-updates list for
  visitors with no account; registered by `server/plugins/subscribers.ts`. The
  first is behind Turnstile and two rate limits, the others behind a signed link.

Features and forks add their own from a Nitro plugin; **never edit the
middleware**:

```typescript
registerPublicApiRoutes([
  { path: '/api/problems', match: 'prefix', methods: ['GET'] }, // a public catalogue
  { path: '/api/join/', match: 'prefix', methods: ['POST'] },   // an invite link
])
registerSessionGatedPrefixes(['/posters/']) // private media served outside /api/
```

`methods` scopes a rule (omit for all methods), `match` is `exact` (default) or
`prefix` (`startsWith`; end a directory prefix with `/` so `/api/join/` does not
admit `/api/joinery`). The feedback layer registers `POST /api/feedback` this way
— signed-out visitors may leave feedback; the handler rate-limits by IP hash — so
removing the layer removes the route. `registerSessionGatedPrefixes` makes the
middleware require a session for a non-`/api/` prefix too.

Everything else, including every paid route, is behind the session guard and
then its own gate: `requireAccess()` (billing registers `requireSubscription` behind it, in `layers/billing/server/utils/billing.ts`) or `requireAdmin()`.

## Rate Limiting

`rateLimit(event, { name, limit, windowSeconds })` counts every call in D1 and, for
a call site whose numbers match it, asks Cloudflare's **native Rate Limiting
binding** first. Applied to the whole `/api/auth/` surface in
`server/middleware/auth.ts` and per-user on connect-code minting.

- **The count is exact.** One row per caller, endpoint and window in `rate_limits`,
  moved by a single `INSERT … ON CONFLICT DO UPDATE … RETURNING count`
  (`d1RateLimitStore`). Two requests can never read the same count, and it is one
  count across every Cloudflare location. The key is hashed. Don't replace it with
  read-then-write on any store: 75 simultaneous requests were once counted as 10.
- **The native binding only refuses.** It is a first check that saves a D1 write on
  a flood down one connection. It must never be the only thing between a caller and
  an endpoint: on production it let through every request that opened its own
  connection. `nativeFor` gives it to a call site **only when both numbers match**
  `NATIVE_LIMITER`; `period` may only be **10 or 60**.
- **A second native budget** (a stricter first check for an expensive create endpoint) is a
  second `[[ratelimits]]` block (own `name`, own `namespace_id`, in `[env.preview]` too) plus
  one line in a Nitro plugin, never an edit to `rate-limit.ts`:
  `registerNativeLimiter({ binding: 'GAME_CREATE_LIMITER', limit: 5, windowSeconds: 60 })`.
  Two bindings with the same budget are refused. A fork's named budgets
  (`const INGEST_LIMITER = { name, limit, windowSeconds }`, passed straight to `rateLimit()`
  like `UNSUBSCRIBE_LIMITER`) belong in a file of the fork's own, not in `rate-limit.ts`.
- **`/ingest/**`** (the PostHog relay) can be rate-limited: off by default, because the count
  costs a D1 write per relayed request. `configureIngestRelay({ rateLimit: true })` turns on
  300 requests per 120s per address, keyed by `clientIpHash()`. An app that needs other
  numbers calls `configureIngestRelay({ limit, windowSeconds })` from a Nitro plugin
  (`server/utils/ingest-relay.ts`); don't edit the route. The relay also forwards an explicit
  header allowlist (`server/utils/ingest-headers.ts`), never `Cookie` or `Authorization`.
- **`cost`** makes one call spend several (a JSON-RPC batch passes its message count), so an
  over-budget batch is refused whole.
- **`exact: false`** is for a high-volume, low-stakes call site, such as a public read path,
  that must not pay a D1 write per request. Where its numbers match a native limiter, that
  limiter decides alone. The limit is then loose: a client opening a connection per request is
  never refused. Never in front of sign-in, a token, or anything that costs money.
- Changing the auth limit means changing `NATIVE_LIMITER` **and** `wrangler.toml`.
  `test/rate-limit.test.ts` fails when they drift.
- It **fails open** (an outage in abuse control must not take sign-in down), logged as
  `rate_limit_unavailable`. A native binding that throws is ignored; the count decides.
- This is abuse control, not metering. Anything you bill on needs a Durable Object.
- Finished windows are removed by the daily purge (`pruneRateLimits`).

## Bot Protection (Turnstile)

`requireTurnstile(event, token)` (`server/utils/turnstile.ts`) — throws 400 with a
`data.code` when a challenge fails. Wired on the two endpoints a stranger can
reach: `POST /api/auth/magic-link` and anonymous `POST /api/feedback`. Signed-in
feedback skips it, because `useFeedback().submit()` is also called
programmatically with no widget on screen.

- **Unset `NUXT_TURNSTILE_SECRET_KEY` = skipped**, like Resend. Site key without
  secret key is the one bad state and logs `turnstile_half_configured`.
- Render `<NuxtTurnstile>` behind a `useRuntimeConfig().public.turnstile.siteKey`
  check, never unconditionally — an unconfigured fork must load nothing.
- Unlike the rate limiters it **fails closed**: a bot check that failed open is a
  bypass an attacker can trigger by making `siteverify` slow.
- **On the mint path it runs first**, before the per-address bucket is charged.
  A challenge behind the limiter lets an unsolved bot burn a victim's budget and
  lock them out of their own sign-in — the limiter becomes the attack.
- `https://challenges.cloudflare.com` is already in `script-src` and `frame-src`.


