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
  const publicRoutes = ['/api/health', '/api/auth/', '/api/_auth/']

  // Throttle the whole auth surface from one place. Doing it here rather than
  // inside each handler is what makes it cover the OAuth routes at all:
  // defineOAuthGitHubEventHandler owns its entire request, so there's no hook
  // inside it to add a limit to. Generous enough for a human bouncing between
  // providers, tight enough to stop a callback-replay script.
  if (path.startsWith('/api/auth/')) {
    await rateLimit(event, { name: 'auth', limit: 30, windowSeconds: 60 })
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
      // subsequent request instead of only on the ones that happen to 401. The
      // Set-Cookie rides out on whichever response follows.
      await clearUserSession(event)

      // Signing out is the one thing a revoked session is still allowed to do.
      // It authorizes nothing — it destroys a credential — and 401ing it would
      // make useUserSession().clear() throw, which it does not catch, turning
      // "your session ended" into an unhandled rejection in the UI.
      const isSignOut =
        (path === '/api/_auth/session' && event.method === 'DELETE') || path === '/api/auth/logout'
      if (!isSignOut) {
        // 401 on GET /api/_auth/session too, and that is what makes the UI heal
        // rather than hang: useUserSession().fetch() DOES catch a failed
        // response and sets the session to null, so the other browser flips to
        // signed-out on its next refresh. Falling through instead would achieve
        // nothing — h3's clearSession drops the cached session from the request
        // context, so the endpoint would re-unseal the same cookie and report
        // the revoked user as present.
        throw createError({ statusCode: 401, message: 'Unauthorized' })
      }
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
