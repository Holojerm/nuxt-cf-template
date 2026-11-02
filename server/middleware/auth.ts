// Server middleware — runs on every request.
//
// Three jobs, in order: throttle the sign-in surface, refuse a session the
// account behind it has revoked, then require a session for everything under
// /api/ that isn't explicitly public.

export default defineEventHandler(async (event) => {
  // Strip the query string — public-route rules match the bare path.
  const path = event.path.split('?')[0] ?? ''

  // Throttle the whole auth surface from one place. Doing it here rather than
  // inside each handler is what makes it cover the OAuth routes at all:
  // defineOAuthGitHubEventHandler owns its entire request, so there's no hook
  // inside it to add a limit to. Generous enough for a human bouncing between
  // providers, tight enough to stop a callback-replay script.
  //
  // The numbers come from NATIVE_LIMITER rather than being written here, and
  // that is load-bearing: rateLimit() only delegates to Cloudflare's native
  // binding for a call site whose limit and window match what wrangler.toml
  // declared, since the binding's budget is fixed at deploy. Typing `25` here
  // would move this endpoint — the one the binding was sized for — back onto
  // KV, and nothing would fail. To change the limit, change it in
  // server/utils/rate-limit.ts and in wrangler.toml's `[[ratelimits]]` block.
  if (path.startsWith('/api/auth/')) {
    await rateLimit(event, {
      name: 'auth',
      limit: NATIVE_LIMITER.limit,
      windowSeconds: NATIVE_LIMITER.windowSeconds,
    })
  }

  // ── Revocation ─────────────────────────────────────────────────────────────
  // Runs BEFORE the public-route bail-out, and that placement is the point.
  // A sealed cookie carries no server-side record, so this is the only moment
  // in the request where a revoked session can be caught — and it has to cover
  // /api/_auth/session too, or a deleted account's other browser keeps
  // rendering a signed-in shell forever because the one endpoint that reports
  // "are you signed in?" was the one endpoint that never checked.
  //
  // Scoped to /api/ and to requests that actually carry a session: page renders
  // are not gated here (the client discovers it on its next API call), and a
  // request with no cookie costs nothing. That keeps the price at one indexed
  // read per authenticated API call — see server/utils/session-guard.ts for why
  // that read is not cached.
  const session = path.startsWith('/api/') ? await getUserSession(event) : null
  if (session?.user) {
    const verdict = await checkSession(db, {
      userId: session.user.id,
      issuedAt: session.issuedAt,
    })
    if (!verdict.valid) {
      console.warn(JSON.stringify({ kind: 'session_revoked', reason: verdict.reason }))
      // Clear it so the browser stops presenting a dead credential on every
      // subsequent request instead of only on the ones that happen to 401.
      //
      // Worth knowing where that Set-Cookie does and does not land: on a real
      // request it rides out on the response below, but during SSR the /login
      // page's `useFetch` is an INTERNAL h3 event, and Nuxt does not forward
      // headers off an internal response to the outer one. (nuxt-auth-utils'
      // own `clear()` has to hand-copy `getSetCookie()` for exactly this
      // reason.) So on that path the browser keeps the dead cookie until its
      // next real request — which is fine, because that request gets cleared
      // too, and nothing here depends on the clear having arrived.
      await clearUserSession(event)

      // Which paths must NOT be aborted, and why, is a rule with a nasty
      // failure mode — see isSessionClearOnlyPath(), where it lives so
      // test/session-guard.test.ts can enumerate it.
      if (!isSessionClearOnlyPath(path, event.method)) {
        throw createError({ statusCode: 401, message: 'Unauthorized' })
      }
    } else {
      // Hand the row on rather than making requireAdmin() read it again. Both
      // run on every admin request and both look up the same primary key.
      event.context[SESSION_ROLE_CONTEXT_KEY] = verdict.role
    }
  }

  // Public routes — no auth needed. The list lives in
  // server/utils/public-routes.ts: core's own (health, status/fleet, sign-in,
  // the blog, unsubscribe) plus whatever a feature or fork registered from a
  // Nitro plugin (feedback registers POST /api/feedback). Rules are
  // method-scoped, so a public GET never makes a later POST public with it.
  // The full list is documented in .claude/docs/auth.md › Public API surface.
  if (isPublicApiRequest(path, event.method)) {
    return
  }

  // All other /api routes, and any non-API prefix an app registered with
  // registerSessionGatedPrefixes(), require a valid session. /api/ was read
  // above; a gated prefix is the only case that reads it here.
  if (isSessionGatedPath(path)) {
    const gateSession = session ?? (await getUserSession(event))
    if (!gateSession.user) {
      throw createError({
        statusCode: 401,
        message: 'Unauthorized',
      })
    }
  }
})
