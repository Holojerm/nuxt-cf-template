// The first-touch landing page, reduced to a path that is safe to count.
//
// The landing path ends up in `users.signup_landing` and, grouped, in the
// /api/fleet payload that another app stores. A raw pathname can carry a
// secret or an id (`/invite/<token>`, `/orders/18234`), so only the route
// shape survives: the query string and fragment are dropped, and any segment
// that does not read as a word or slug becomes `:id`. That also keeps
// `/posts/123` and `/posts/456` in one bucket, which is what a "signups by
// landing page" count wants.

export const LANDING_MAX = 120
const SEGMENT_LIMIT = 8
const SEGMENT_MAX = 48
const OPAQUE = ':id'

/** What landingPath() produces; anything else is rejected rather than stored. */
export const LANDING_PATTERN = /^\/[a-z0-9._:/-]*$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a segment that looks like an id or a token rather than a slug. */
function isOpaque(segment: string): boolean {
  if (segment.length > SEGMENT_MAX) return true
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) return true
  if (UUID.test(segment)) return true
  for (const run of segment.split(/[._-]/)) {
    // No word in a slug is this long; a hash or a token is.
    if (run.length >= 16) return true
    if (/^\d{5,}$/.test(run)) return true
    if (run.length >= 8 && /\d/.test(run) && /[A-Za-z]/.test(run)) return true
  }
  return false
}

/**
 * `https://app.example/Blog/Rate-Limits/?utm_source=x` → `/blog/rate-limits`.
 * Returns undefined for a URL that does not parse.
 */
export function landingPath(url: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return undefined
  }
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .slice(0, SEGMENT_LIMIT)
    .map((segment) => (isOpaque(segment) ? OPAQUE : segment.toLowerCase()))
  const path = `/${segments.join('/')}`
  return path.length <= LANDING_MAX ? path : undefined
}
