// Server middleware — runs on every request: throttle the sign-in surface,
// refuse a session its account has revoked, then require a session under /api/
// unless the route is public.

export default defineEventHandler(async (event) => {
  // Public-route rules match the bare path.
  const path = event.path.split('?')[0] ?? ''

  // Throttled here, not per handler: defineOAuthGitHubEventHandler owns its whole
  // request, so OAuth routes have no hook for a limit. The numbers come from
  // NATIVE_LIMITER because rateLimit() delegates to the native binding only for
  // numbers matching wrangler.toml; typing `25` would silently move this endpoint
  // back to KV. To change it, change NATIVE_LIMITER and `[[ratelimits]]` together.
  if (path.startsWith('/api/auth/')) {
    await rateLimit(event, {
      name: 'auth',
      limit: NATIVE_LIMITER.limit,
      windowSeconds: NATIVE_LIMITER.windowSeconds,
    })
  }

  // Revocation runs BEFORE the public-route bail-out: a sealed cookie has no
  // server record, so this is the only place a revoked session is caught, and it
  // must cover /api/_auth/session or a deleted account's other browser renders
  // signed-in forever. Scoped to /api/ and to requests carrying a session (pages
  // learn on their next API call), so it costs one indexed read per authenticated
  // API call (session-guard.ts on why it is not cached).
  const session = path.startsWith('/api/') ? await getUserSession(event) : null
  if (session?.user) {
    const verdict = await checkSession(db, {
      userId: session.user.id,
      issuedAt: session.issuedAt,
    })
    if (!verdict.valid) {
      logEvent('warn', 'session_revoked', { reason: verdict.reason })
      // Clear it so the browser stops presenting a dead credential. During SSR
      // (/login's `useFetch` is an internal h3 event) Nuxt does not forward this
      // Set-Cookie to the outer response, so the clear lands on the next real
      // request; nothing depends on it arriving.
      await clearUserSession(event)

      // Which paths must NOT be aborted: see isSessionClearOnlyPath().
      if (!isSessionClearOnlyPath(path, event.method)) {
        throw createError({ statusCode: 401, message: 'Unauthorized' })
      }
    } else {
      // Hand the row on so requireAdmin() does not re-read the same primary key.
      event.context[SESSION_ROLE_CONTEXT_KEY] = verdict.role
    }
  }

  // Public routes (server/utils/public-routes.ts: core's plus whatever a feature
  // or fork registered). Rules are method-scoped, so a public GET never makes a
  // later POST public. List: .claude/docs/auth.md › Public API surface.
  if (isPublicApiRequest(path, event.method)) {
    return
  }

  // Everything else under /api/, and any registerSessionGatedPrefixes() prefix, needs a session.
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
