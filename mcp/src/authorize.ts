// OAuth /authorize flow — bridges the MCP client's OAuth request to an app
// user via a connect code (device-code style): the user generates a code while
// signed in to the app (POST /api/mcp/connect-code), pastes it here, and we
// seal their userId into the grant. No shared cookies or upstream IdP needed.
//
// Hardening follows Cloudflare's securing-mcp-servers guidance: CSRF token in
// a __Host- cookie, HTML-escaped client metadata, restrictive CSP.

import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import type { AuthProps, Env } from './env'

const CSRF_COOKIE = '__Host-CSRF_TOKEN'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Same normalization + hash as the app's /api/mcp/connect-code endpoint. */
function hashConnectCode(code: string): Promise<string> {
  return sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/g, ''))
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? ''
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
  return match ? (match.split('=')[1] ?? null) : null
}

function consentPage(opts: {
  clientName: string
  query: string
  csrfToken: string
  error?: string
}): Response {
  const err = opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ''
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect MCP client</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; color: #18181b; }
    form { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 8px rgba(0,0,0,.08); width: min(90vw, 22rem); }
    h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
    p { font-size: .875rem; color: #52525b; }
    .error { color: #dc2626; }
    input { width: 100%; box-sizing: border-box; padding: .6rem; margin: .75rem 0; border: 1px solid #d4d4d8; border-radius: 8px; font-size: 1.1rem; letter-spacing: .1em; text-transform: uppercase; text-align: center; }
    button { width: 100%; padding: .6rem; background: #18181b; color: #fff; border: 0; border-radius: 8px; font-size: .95rem; cursor: pointer; }
  </style>
</head>
<body>
  <form method="POST" action="/authorize?${escapeHtml(opts.query)}">
    <h1>Authorize ${escapeHtml(opts.clientName)}</h1>
    <p>This MCP client will act as you. Generate a connect code while signed in
    to the app (Settings → MCP, or POST /api/mcp/connect-code), then paste it
    here. Codes are single-use and expire after 10 minutes.</p>
    ${err}
    <input name="code" placeholder="XXXX-XXXX" required autocomplete="one-time-code" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}" />
    <button type="submit">Connect</button>
  </form>
</body>
</html>`
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Set-Cookie': `${CSRF_COOKIE}=${opts.csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
    },
  })
}

async function clientNameFor(env: Env, oauthReq: AuthRequest): Promise<string> {
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId)
  return client?.clientName || oauthReq.clientId
}

export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 })

    // Validates client, redirect_uri, response type, PKCE — throws on failure.
    const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request)
    const clientName = await clientNameFor(env, oauthReq)
    const query = url.searchParams.toString()

    if (request.method === 'GET') {
      return consentPage({ clientName, query, csrfToken: crypto.randomUUID() })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
    }

    const form = await request.formData()
    const retry = (error: string) =>
      consentPage({ clientName, query, csrfToken: crypto.randomUUID(), error })

    // CSRF: hidden field must match the cookie set when the form was rendered.
    const csrfForm = String(form.get('csrf_token') ?? '')
    const csrfCookie = readCookie(request, CSRF_COOKIE)
    if (!csrfForm || !csrfCookie || csrfForm !== csrfCookie) {
      return retry('Session expired — try again.')
    }

    // Redeem the connect code: unused, unexpired, matched by hash.
    const codeHash = await hashConnectCode(String(form.get('code') ?? ''))
    const now = Math.floor(Date.now() / 1000)
    const redeemed = await env.DB.prepare(
      `UPDATE mcp_connect_codes SET used_at = ?1
       WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING user_id`,
    )
      .bind(now, codeHash)
      .first<{ user_id: string }>()
    if (!redeemed) return retry('Invalid or expired code.')

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
      userId: redeemed.user_id,
      scope: oauthReq.scope ?? [],
      metadata: { clientName },
      props: { userId: redeemed.user_id, grantedAt: now } satisfies AuthProps,
    })
    return Response.redirect(redirectTo, 302)
  },
}
