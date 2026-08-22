# Auth, sessions, rate limiting, bot protection

Magic-link sign-in, OAuth providers, session revocation, the `rateLimit()` two-backend contract, and Turnstile. Several rules here are load-bearing security invariants — breaking one is a login bypass or an account-enumeration oracle, not a style regression.

> **Load this when:** touching anything under `server/api/auth/`, `server/utils/magic-link.ts`, `server/utils/rate-limit.ts`, `server/utils/turnstile.ts`, session handling, or adding an OAuth provider.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

## Auth Patterns

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
- **Nothing about the address is observable from outside.** The per-address rate
  limit calls the pure `consumeRateLimit()` rather than `rateLimit()`, because
  the wrapper's `X-RateLimit-Remaining` header and 429 would each answer "is this
  stranger mid-sign-in?" to anyone who POSTs their address. Exhaustion, a
  reserved address, and a provider-rejected send all return the same `{ ok: true }`.

GitHub ships **unconfigured on purpose** — it is a developer credential, and a
consumer sign-in page that leads with it tells most visitors the product isn't for
them. Configure it for a devtool fork; it renders last either way
(`server/api/auth/providers.get.ts`).

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
and `app/middleware/subscription.ts` run in the browser and exist so people see
a login page instead of an empty one. Every paid API route must call
`requireSubscription(event)` itself, or the gate is decorative.

**Sessions are revocable.** A sealed cookie has no server-side record, so
revocation needs both halves: every session carries `issuedAt`, and
`users.sessions_invalid_before` is the watermark that kills everything older.
`server/middleware/auth.ts` checks it on every `/api/*` request that carries a
session — one indexed read, deliberately uncached (`server/utils/session-guard.ts`
explains why a cache would reintroduce the bug). Deletion sets the watermark;
that is what makes "delete my account" end the session on the user's other
devices instead of only the one they clicked from. Anything else that must
invalidate sessions sets the same column — do not add a second mechanism.

**Identity is the verified email address.** Signing in with a magic link today
and Google tomorrow on the same address lands on the same account by design.
That's only safe because every caller of `establishSession()` passes an explicit
`emailVerified` — an unverified address would be an account-takeover primitive.
Never default that flag to `true` when adding a provider. The magic-link path is
the one place where that flag is our own evidence rather than a third party's: the
token was mailed to that address and came back.

Adding a provider is three steps: add the `oauth.<name>` keys to
`nuxt.config.ts`, write `server/api/auth/<name>.get.ts` mapping the provider's
user shape onto `OAuthProfile`, and add a row to `server/api/auth/providers.get.ts`
so `/login` renders the button. (Apple is the exception to step two twice over:
its callback is a cross-site form POST, so that route is `apple.ts` with no
method suffix, and it needs `NUXT_OAUTH_APPLE_REDIRECT_URL` because its handler
does not fall back to the request origin the way the others do.)

**Never put a secret in a URL a browser will keep.** Two flows here have to hand
someone a credential in a link — the sign-in link and the unsubscribe link — and
three places will happily record it: Cloudflare Logs (`event.path` includes the
query; use `pathForLog()`), the `Referer` the `/ingest` proxy forwards to
PostHog, and PostHog autocapture, which attaches `location.href` to every event.
Put the token in the **fragment** where possible, and scrub the rest through
`app/utils/analytics-privacy.ts`. Analytics access is handed out far more freely
than database access, which is exactly why nothing secret may travel there.

## Rate Limiting

`rateLimit(event, { name, limit, windowSeconds })` — one call, two backends. It
prefers Cloudflare's **native Rate Limiting binding** (`[[ratelimits]]` in
`wrangler.toml`, resolved off `event.context.cloudflare.env`) and otherwise uses
the original **KV fixed window**. Applied to the whole `/api/auth/` surface in
`server/middleware/auth.ts`, per-address on magic-link requests (keyed by a salted
hash, never the raw address), and per-user on connect-code minting.

The binding's `(limit, period)` is fixed at deploy — `limit({ key })` takes only a
key — so `chooseBackend` delegates to it **only when both numbers match**
`NATIVE_LIMITER`, and everything else stays on KV. Don't relax that: routing a
20/60s handler through a 30/60s binding enforces 30 while `X-RateLimit-Limit: 20`
goes out on the response, and nothing fails. `period` may only be **10 or 60**.

- Changing the auth limit means changing `NATIVE_LIMITER` **and** `wrangler.toml`.
  `test/rate-limit.test.ts` drives the real binding and fails when they drift.
- Both backends **fail open** (an outage in the abuse-control layer must not take
  sign-in down). A throwing binding does not cascade to KV — one policy, logged.
- The binding counts **per colo**; KV is eventually consistent. Either way this is
  abuse control, not metering. Anything you bill on needs a Durable Object.
- Each call site logs its backend once per isolate (`rate_limit_backend`), with a
  `reason` when it fell back. Read that before assuming the binding is in play.

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


