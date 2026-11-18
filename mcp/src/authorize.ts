// OAuth /authorize: who is connecting comes from the app's own sign-in.
//
//   GET  /authorize            validate the client's request, remember it in a
//                              cookie, send the browser to the app's /auth/mcp
//   (the app)                  signed in there, the app mints a single-use code
//                              bound to this request and sends the browser back
//   GET  /authorize/callback   show who is about to be connected, and to what
//   POST /authorize/callback   spend the code and seal the user into the grant
//
// The code crosses between the two origins through the shared D1 database, so
// the worker and the app share no cookie and no secret (see signin.ts).
//
// The consent page is rendered here and not by the app because only this
// worker can vouch for the client: its name and redirect URI come from the
// registration, not from a query string the app would have to take on trust.
//
// Hardening follows Cloudflare's securing-mcp-servers guidance: CSRF token in
// a __Host- cookie, HTML-escaped client metadata, restrictive CSP.

import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import fleet from '../../fleet.json'
import type { AuthProps, Env } from './env'
import {
  beginSignin,
  clearSigninCookie,
  peekConnectCode,
  readCookie,
  readSignin,
  redeemConnectCode,
} from './signin'

const CSRF_COOKIE = '__Host-CSRF_TOKEN'
const CALLBACK_PATH = '/authorize/callback'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** The app's origin: where people sign in. APP_URL overrides it for local dev. */
function appOrigin(env: Env): string {
  return (env.APP_URL || fleet.urls.prod).replace(/\/+$/, '')
}

const STYLE = `
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; color: #18181b; }
    main { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 8px rgba(0,0,0,.08); width: min(90vw, 24rem); }
    h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
    p { font-size: .875rem; color: #52525b; }
    strong { color: #18181b; overflow-wrap: anywhere; }
    button { width: 100%; padding: .6rem; margin-top: .75rem; background: #18181b; color: #fff; border: 0; border-radius: 8px; font-size: .95rem; cursor: pointer; }
    a { display: block; margin-top: .75rem; text-align: center; font-size: .875rem; color: #52525b; }`

/** A page from this worker. `csp` is everything after the directives all pages share. */
function htmlPage(opts: { title: string; body: string; csp?: string; status?: number }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <style>${STYLE}
  </style>
</head>
<body>
  <main>${opts.body}</main>
</body>
</html>`
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'${opts.csp ? `; ${opts.csp}` : ''}`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      // The callback URL carries the code; it must not travel on as a Referer.
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  })
}

/** A dead end: nothing to approve, and what to do about it. One wording for every cause. */
function expiredPage(): Response {
  return htmlPage({
    title: 'Connection not completed',
    body: '<h1>Connection not completed</h1><p>This sign-in has expired. Go back to your AI client and connect again.</p>',
    status: 400,
  })
}

/**
 * What `form-action` must allow besides this origin. Chrome enforces the
 * directive against the redirect that follows a form POST, so without the
 * client's (already validated) redirect target the 302 from
 * completeAuthorization is blocked at the last step. A native client's
 * `cursor://…` has no origin, so it is allowed by scheme.
 */
function redirectSource(redirectUri: string): string {
  const url = new URL(redirectUri)
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : url.protocol
}

/** Where "Cancel" goes: back to a web client as access_denied. A native scheme gets no link. */
function denyUrl(oauthReq: AuthRequest): string | null {
  const url = new URL(oauthReq.redirectUri)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  url.searchParams.set('error', 'access_denied')
  if (oauthReq.state) url.searchParams.set('state', oauthReq.state)
  return url.toString()
}

function consentPage(opts: {
  clientName: string
  email: string
  code: string
  oauthReq: AuthRequest
}): Response {
  const csrfToken = crypto.randomUUID()
  const redirect = new URL(opts.oauthReq.redirectUri)
  const deny = denyUrl(opts.oauthReq)
  const response = htmlPage({
    title: `Connect ${opts.clientName}`,
    body: `
    <form method="POST" action="${CALLBACK_PATH}">
      <h1>Connect ${escapeHtml(opts.clientName)} to ${escapeHtml(fleet.name)}?</h1>
      <p>It will act as <strong>${escapeHtml(opts.email)}</strong>, and can read and change what that account can.</p>
      <p>After you approve, you return to <strong>${escapeHtml(redirect.host || redirect.protocol)}</strong>.</p>
      <input type="hidden" name="code" value="${escapeHtml(opts.code)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <button type="submit">Approve</button>
      ${deny ? `<a href="${escapeHtml(deny)}">Cancel</a>` : ''}
    </form>`,
    csp: `form-action 'self' ${redirectSource(opts.oauthReq.redirectUri)}`,
  })
  response.headers.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=${csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  )
  return response
}

async function clientNameFor(env: Env, oauthReq: AuthRequest): Promise<string> {
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId)
  return client?.clientName || oauthReq.clientId
}

/** Step one: remember the client's request and send the browser to the app. */
async function startSignin(request: Request, env: Env): Promise<Response> {
  // Validates client, redirect_uri, response type, PKCE — throws on failure.
  // Checked here so a bad request never costs the user a sign-in, and again at
  // the callback, where the query comes back out of a cookie.
  await env.OAUTH_PROVIDER.parseAuthRequest(request)
  const { requestId, cookie } = await beginSignin(new URL(request.url).searchParams.toString())
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${appOrigin(env)}/auth/mcp?request=${requestId}`,
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
  })
}

/** Steps two and three: the browser is back from the app with a code. */
async function finishSignin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  }
  const url = new URL(request.url)
  const pending = await readSignin(request)
  if (!pending) return expiredPage()

  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(
    new Request(new URL(`/authorize?${pending.query}`, url)),
  )
  const clientName = await clientNameFor(env, oauthReq)
  const now = Math.floor(Date.now() / 1000)

  if (request.method === 'GET') {
    // The id in the URL is the app's echo of the one it was given. A mismatch
    // is a callback link opened in a browser that started a different sign-in.
    if (url.searchParams.get('request') !== pending.requestId) return expiredPage()
    const code = url.searchParams.get('code') ?? ''
    const owner = await peekConnectCode(env.DB, code, pending.requestId, now)
    if (!owner) return expiredPage()
    return consentPage({ clientName, email: owner.email, code, oauthReq })
  }

  const form = await request.formData()

  // CSRF: hidden field must match the cookie set when the form was rendered.
  const csrfForm = String(form.get('csrf_token') ?? '')
  const csrfCookie = readCookie(request, CSRF_COOKIE)
  if (!csrfForm || !csrfCookie || csrfForm !== csrfCookie) return expiredPage()

  const redeemed = await redeemConnectCode(
    env.DB,
    String(form.get('code') ?? ''),
    pending.requestId,
    now,
  )
  if (!redeemed) return expiredPage()

  // `grantedAt` is what makes this grant revocable later. It lives in
  // OAUTH_KV, which the app cannot reach — deleting your account cannot go and
  // delete a grant it does not know exists — so the grant has to carry a date
  // that server.ts can compare against `users.sessions_invalid_before`.
  // Seconds, matching that column and the app's session `issuedAt`.
  //
  // `now` is already the second-resolution clock used for the code redemption
  // above, so a grant and the code it came from agree on when this happened.
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: redeemed.userId,
    scope: oauthReq.scope ?? [],
    metadata: { clientName },
    props: { userId: redeemed.userId, grantedAt: now } satisfies AuthProps,
  })
  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo, 'Set-Cookie': clearSigninCookie, 'Cache-Control': 'no-store' },
  })
}

export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === CALLBACK_PATH) return finishSignin(request, env)
    if (pathname !== '/authorize') return new Response('Not found', { status: 404 })
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } })
    }
    return startSignin(request, env)
  },
}
