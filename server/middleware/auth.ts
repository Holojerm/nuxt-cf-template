// Server middleware — runs on every /api/* request
// Use this for global auth checks, logging, CORS, etc.

export default defineEventHandler(async (event) => {
  // Only protect /api routes that aren't public. Strip the query string —
  // the feedback rule below matches an exact path.
  const path = event.path.split('?')[0] ?? ''

  // Public routes — no auth needed.
  // - /api/health: liveness probe
  // - /api/auth/: OAuth callbacks registered by nuxt-auth-utils handlers
  // - /api/_auth/: session endpoint nuxt-auth-utils calls from useUserSession()
  //   (fetch + clear); blocking this 401s sign-out and breaks session refresh
  const publicRoutes = ['/api/health', '/api/auth/', '/api/_auth/']

  if (publicRoutes.some((route) => path.startsWith(route))) {
    return
  }

  // Anonymous feedback: submitting is public, reading and triaging are not.
  // Method-scoped so GET /api/feedback and PATCH /api/feedback/:id stay gated.
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
