/**
 * Reduce a requested redirect to something safe to send a browser to.
 *
 * Only same-origin paths survive. `//evil.com` and `/\evil.com` are both parsed
 * as protocol-relative URLs by browsers, so a naive `startsWith('/')` check is
 * an open redirect — the classic way a login flow becomes a phishing launchpad:
 * send someone a link to YOUR login page, have it bounce them to a copy of it,
 * and the address bar was right up until the moment it wasn't.
 *
 * Backslashes matter because several browsers normalize `\` to `/` in URLs, so
 * `/\evil.com` reaches the network as `//evil.com`.
 *
 * Shared so the login page (which navigates client-side when already signed in)
 * and the server (which redirects after OAuth and magic link) apply one rule.
 * test/auth-redirect.test.ts enumerates the bypasses.
 */
export function safeRedirectPath(raw: string | undefined, fallback = '/'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/')) return fallback
  // Second character decides: a slash or backslash makes it protocol-relative.
  if (raw[1] === '/' || raw[1] === '\\') return fallback
  // A control character or whitespace can be used to smuggle a scheme past the
  // checks above once the browser strips it. Matching control characters is the
  // entire point here, hence the disable.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return fallback
  return raw
}
