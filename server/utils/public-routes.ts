// Which requests the auth middleware (server/middleware/auth.ts) lets through
// without a session, and which non-API paths it additionally gates.
//
// The allowlist used to be an array and a stack of `if`s inside the middleware,
// so every fork that had one more public endpoint (a catalogue, a join link, a
// webhook) edited the middleware, and every template sync re-conflicted on it.
// Core now keeps only what core ships; a feature or fork registers the rest
// from a Nitro plugin — the same pattern as server/utils/extensions.ts, and for
// the same reason (a plain module registry, so the workerd vitest pool can call
// the same functions Nitro plugins do).
//
//   registerPublicApiRoutes([{ path: '/api/problems', match: 'prefix', methods: ['GET'] }])
//
// The registry is deliberately dumb: it answers "is this request public?" and
// nothing else. Rate limiting, handler-level auth and CSRF are untouched.

export interface PublicApiRoute {
  /** `/api/…`. With `match: 'prefix'` this is a plain `startsWith`. */
  path: string
  /** `exact` (default) compares the whole path; `prefix` is `startsWith`. */
  match?: 'exact' | 'prefix'
  /**
   * Methods that are public. Omit for all. Scope every write route: a public
   * GET must not silently make a later POST on the same path public too.
   */
  methods?: readonly string[]
}

/**
 * What core ships. Frozen here rather than in the middleware so the list in
 * `.claude/docs/auth.md › Public API surface` has one place to be checked
 * against. Features register their own (feedback: `POST /api/feedback`).
 */
export const CORE_PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  // liveness
  { path: '/api/health', match: 'prefix' },
  // portfolio dashboard — each does its own bearer check (requireFleetToken)
  { path: '/api/status', match: 'prefix' },
  { path: '/api/fleet', match: 'prefix' },
  // sign-in start, OAuth callbacks, and the session endpoint useUserSession() reads
  { path: '/api/auth/', match: 'prefix' },
  { path: '/api/_auth/', match: 'prefix' },
  // @nuxt/icon's endpoint, which the browser calls for any icon the client
  // bundle missed; it serves static icon JSON and a signed-out visitor needs it.
  { path: '/api/_nuxt_icon/', match: 'prefix' },
  // the blog is public content; crawlers cannot sign in
  { path: '/api/blog', methods: ['GET'] },
  { path: '/api/blog/', match: 'prefix', methods: ['GET'] },
  // one-click unsubscribe: mail providers POST with no session (RFC 8058)
  { path: '/api/email/unsubscribe', methods: ['GET', 'POST'] },
]

const registeredRoutes = new Map<string, PublicApiRoute>()
const gatedPrefixes = new Set<string>()

const routeKey = (route: PublicApiRoute) =>
  `${route.match ?? 'exact'}|${route.path}|${(route.methods ?? []).join(',')}`

/** Allow requests without a session. Registering the same rule twice is a no-op. */
export function registerPublicApiRoutes(routes: readonly PublicApiRoute[]): void {
  for (const route of routes) {
    if (!route.path.startsWith('/api/')) {
      throw new Error(`registerPublicApiRoutes: "${route.path}" is not under /api/`)
    }
    registeredRoutes.set(routeKey(route), route)
  }
}

/**
 * Require a session for non-API paths too (private media, a script proxy).
 * Core gates only `/api/`; a fork serving private files from a route needs this.
 */
export function registerSessionGatedPrefixes(prefixes: readonly string[]): void {
  for (const prefix of prefixes) {
    if (prefix.startsWith('/api/')) {
      throw new Error(`registerSessionGatedPrefixes: "${prefix}" is under /api/, already gated`)
    }
    gatedPrefixes.add(prefix)
  }
}

export function getPublicApiRoutes(): PublicApiRoute[] {
  return [...CORE_PUBLIC_API_ROUTES, ...registeredRoutes.values()]
}

function matches(route: PublicApiRoute, path: string, method: string): boolean {
  if (route.methods && !route.methods.includes(method.toUpperCase())) return false
  return route.match === 'prefix' ? path.startsWith(route.path) : path === route.path
}

/** `path` is the request path without its query string. */
export function isPublicApiRequest(path: string, method: string): boolean {
  return getPublicApiRoutes().some((route) => matches(route, path, method))
}

/** Does this request need a session? True for `/api/*` and any registered prefix. */
export function isSessionGatedPath(path: string): boolean {
  return path.startsWith('/api/') || [...gatedPrefixes].some((prefix) => path.startsWith(prefix))
}

/** Test-only: forget every registration, to exercise core with nothing added. */
export function clearPublicRoutesForTest(): void {
  registeredRoutes.clear()
  gatedPrefixes.clear()
}
