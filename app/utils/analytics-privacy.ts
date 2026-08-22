// Keep credentials out of the analytics pipeline.
//
// ── The bug this exists to prevent ───────────────────────────────────────────
// Two of this app's flows put a single-use credential in a URL: the magic-link
// confirmation page and the one-click unsubscribe link. PostHog's autocapture
// attaches `window.location.href` to every event it records — every click,
// every form interaction, every dead click — and `$pageview` carries the URL
// too. Left alone, that means the live sign-in token of every person signing in
// is written to the analytics warehouse *before they click the confirm button*,
// where anyone with read access to the project can redeem it inside the
// fifteen-minute window. Session replay records the same URLs.
//
// That is a worse exposure than the one the magic-link design already defends
// against (a mail scanner spending the token), because it is silent, retained,
// and reaches a much wider set of people — analytics access is handed out far
// more freely than production database access, and rightly so, which is exactly
// why nothing secret may travel there.
//
// ── Defence in depth, not a single fix ───────────────────────────────────────
// This module is one of four layers, and it is the last one rather than the
// first:
//   1. The token rides in the URL *fragment* (`/auth/verify#token=…`), which
//      browsers never put on the wire — so it reaches no server log, no proxy,
//      and no Referer header. See server/api/auth/magic-link.post.ts.
//   2. `$pageview` is captured with `to.path`, never `to.fullPath`.
//   3. server/routes/ingest/[...path].ts strips the query and fragment from the
//      Referer it forwards upstream.
//   4. This sanitizer, wired to posthog-js's `sanitize_properties`, scrubs
//      anything that got past 1–3 — which is the point of having it, since
//      autocapture reads `location.href` directly and neither 1 nor 2 can reach
//      that.
//
// `scrubUrl` is also used outside analytics, by app/composables/useFeedback.ts:
// the feedback widget is on every page and records the URL it was opened from
// into D1. Anywhere a current URL is about to be *stored* rather than just
// followed, it goes through here first.

/** What a redacted value is replaced with. Kept visible so URLs stay readable. */
export const REDACTED = 'redacted'

/**
 * Query/fragment parameter names whose values are credentials.
 *
 * `t`, `u`, and `e` are the unsubscribe link's parameters
 * (server/utils/unsubscribe.ts). They are short and generic enough to collide
 * with an innocent marketing parameter somewhere, and that trade is deliberate:
 * the cost of a false positive is one unreadable value on a URL property in
 * PostHog, and the cost of a false negative is a signed token in the warehouse.
 */
const SENSITIVE_PARAMS = new Set(['token', 't', 'u', 'e'])

/** Property keys whose string values are URLs and must be scrubbed. */
const URL_PROPERTY = /url|referrer|pathname|href|location/i

/** Nested property bags posthog-js sends person properties inside. */
const NESTED_PROPERTY_BAGS = new Set(['$set', '$set_once'])

/** Replace sensitive parameters inside one `?a=b&c=d` or `#a=b` section. */
function scrubParams(search: string): string {
  const params = new URLSearchParams(search)
  let touched = false
  for (const key of [...params.keys()]) {
    if (!SENSITIVE_PARAMS.has(key)) continue
    params.set(key, REDACTED)
    touched = true
  }
  return touched ? params.toString() : search
}

/**
 * Redact credentials from anything URL-shaped, without needing it to parse.
 *
 * Deliberately string surgery rather than `new URL()`: the values arriving here
 * include bare paths (`/auth/verify?token=…`), fragments, and occasionally
 * junk, and a parser that throws on a relative URL would either need a fake
 * base or a try/catch that silently passes the unscrubbed value through. This
 * cannot throw, and an input it does not understand comes back unchanged rather
 * than dropped — the failure mode of over-redacting an unrecognised string is
 * losing analytics, which is not what this trade is about.
 */
export function scrubUrl(value: string): string {
  const hashIndex = value.indexOf('#')
  const head = hashIndex === -1 ? value : value.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1)

  const queryIndex = head.indexOf('?')
  const path = queryIndex === -1 ? head : head.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : head.slice(queryIndex + 1)

  const scrubbedQuery = query ? scrubParams(query) : ''
  // A fragment is only scrubbed when it looks like parameters. A plain anchor
  // (`#pricing`) is not a credential and mangling it into `pricing=` would make
  // every deep link in the analytics unreadable for no gain.
  const scrubbedFragment = fragment.includes('=') ? scrubParams(fragment) : fragment

  return (
    path +
    (queryIndex === -1 ? '' : `?${scrubbedQuery}`) +
    (hashIndex === -1 ? '' : `#${scrubbedFragment}`)
  )
}

/**
 * posthog-js `sanitize_properties` hook: scrub every URL-ish property, one
 * level into the person-property bags.
 *
 * Mutating a copy rather than the original, because posthog-js hands over an
 * object it may reuse.
 */
export function sanitizeAnalyticsProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...properties }

  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string' && URL_PROPERTY.test(key)) {
      sanitized[key] = scrubUrl(value)
      continue
    }
    // `$set` / `$set_once` carry `$initial_current_url` and friends, which are
    // the properties that would otherwise pin a token to a person profile
    // permanently rather than to one event.
    if (NESTED_PROPERTY_BAGS.has(key) && value && typeof value === 'object') {
      sanitized[key] = sanitizeAnalyticsProperties(value as Record<string, unknown>)
    }
  }

  return sanitized
}
