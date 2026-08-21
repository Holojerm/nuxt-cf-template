// Server middleware — runs on every request.
//
// Two jobs, in order: throttle the sign-in surface, then require a session for
// everything under /api/ that isn't explicitly public.

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

  // All other /api routes require a valid session
  if (path.startsWith('/api/')) {
    const session = await getUserSession(event)

    if (!session.user) {
      throw createError({
        statusCode: 401,
        message: 'Unauthorized',
      })
    }
  }
})
