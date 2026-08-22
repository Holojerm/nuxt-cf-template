// Server middleware — runs on every request.
//
// Three jobs, in order: throttle the sign-in surface, refuse a session the
// account behind it has revoked, then require a session for everything under
// /api/ that isn't explicitly public.

export default defineEventHandler(async (event) => {
  // Only protect /api routes that aren't public. Strip the query string —
  // the feedback rule below matches an exact path.
  const path = event.path.split('?')[0] ?? ''

  // Public routes — no auth needed.
  // - /api/health: liveness probe
  // - /api/auth/: sign-in start + OAuth callbacks, provider list, logout.
  //   The session doesn't exist yet on these, so the guard below must not run.
  // - /api/_auth/: session endpoint nuxt-auth-utils calls from useUserSession()
  //   (fetch + clear); blocking this 401s sign-out and breaks session refresh
  // - /api/status: deployment status for the portfolio dashboard and external
  //   heartbeats — public by design, carries no secrets (see the route)
  // - /api/fleet: counters for the dashboard; does its own bearer check, and
  //   404s when no token is configured, so the session guard must not 401 first
  const publicRoutes = ['/api/health', '/api/status', '/api/fleet', '/api/auth/', '/api/_auth/']

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

  if (publicRoutes.some((route) => path.startsWith(route))) {
    return
  }

  // Anonymous feedback: submitting is public, reading and triaging are not.
  // Method-scoped so GET /api/feedback and PATCH /api/feedback/:id stay gated.
  //
  // No rateLimit() call here on purpose — the handler counts prior rows by
  // ip_hash in D1 (5/hour), which is exact rather than eventually consistent and
  // reuses a write it was making anyway. A second KV window on top would just be
  // two different limits to reason about.
  if (path === '/api/feedback' && event.method === 'POST') {
    return
  }

  // The blog. Reading it must not require an account — that is the entire
  // point of publishing it, and the readers who matter most (Googlebot,
  // GPTBot, ClaudeBot) cannot sign in at all. Method-scoped like the rules
  // above: there is no write endpoint here today, and if one is ever added it
  // should have to opt out of the guard deliberately rather than inherit it.
  if ((path === '/api/blog' || path.startsWith('/api/blog/')) && event.method === 'GET') {
    return
  }

  // One-click unsubscribe: mail providers POST here with no session (RFC 8058
  // List-Unsubscribe-Post) and people click the same URL from an email's
  // footer, which is a GET. Method-scoped like the feedback rule above — a
  // PUT or DELETE to this path still 404s at the router, this just stops the
  // auth guard from turning it into a 401 first. Auth would defeat the whole
  // point: nobody signed into anything is on the other end of either request.
  if (path === '/api/email/unsubscribe' && (event.method === 'GET' || event.method === 'POST')) {
    return
  }

  // All other /api routes require a valid session. Already read above, so this
  // costs nothing beyond the check itself.
  if (path.startsWith('/api/')) {
    if (!session?.user) {
      throw createError({
        statusCode: 401,
        message: 'Unauthorized',
      })
    }
  }
})
