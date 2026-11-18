// The sign-in hand-off between this worker and the app, minus the HTTP: the
// cookie that remembers a pending /authorize request, and the single-use code
// the app mints for it.
//
// ── Why there is a secret behind the request id ──────────────────────────────
// The browser carries two things from the app back to this worker in a URL:
// the request id and the code. A URL reaches Cloudflare's request logs, so
// neither may be enough to spend the code. The id is therefore only the
// SHA-256 of a secret that stays in an HttpOnly cookie; the app binds the code
// to the id, and this worker spends it only for a browser that holds the
// secret. Someone reading both values out of a log still cannot produce the
// cookie.
//
// No imports beyond the platform, so the app's test suite can run this file
// against the route that mints the codes (test/mcp-signin.test.ts).

export const SIGNIN_COOKIE = '__Host-MCP_SIGNIN'
export const SIGNIN_TTL_SECONDS = 600

export interface PendingSignin {
  /** What the app is told, and what the code is bound to. */
  requestId: string
  /** The client's original /authorize query string. */
  query: string
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const toBase64Url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? ''
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
  return match ? match.slice(name.length + 1) || null : null
}

/** Start a sign-in: the id to give the app, and the cookie that proves it later. */
export async function beginSignin(query: string): Promise<{ requestId: string; cookie: string }> {
  const secret = crypto.randomUUID() + crypto.randomUUID()
  return {
    requestId: await sha256Hex(secret),
    // Lax, not Strict: the browser comes back from the app's origin by a
    // top-level redirect, and a Strict cookie would not be sent on it.
    cookie: `${SIGNIN_COOKIE}=${secret}.${toBase64Url(query)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SIGNIN_TTL_SECONDS}`,
  }
}

export const clearSigninCookie = `${SIGNIN_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`

/** The sign-in this browser started, or null if it started none (or it expired). */
export async function readSignin(request: Request): Promise<PendingSignin | null> {
  const value = readCookie(request, SIGNIN_COOKIE)
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot < 1) return null
  try {
    return {
      requestId: await sha256Hex(value.slice(0, dot)),
      query: fromBase64Url(value.slice(dot + 1)),
    }
  } catch {
    return null
  }
}

/**
 * The stored form of a code. Mirrors hashConnectCode() in the app's
 * server/utils/mcp-connect.ts; test/mcp-signin.test.ts holds the two together.
 */
export function hashConnectCode(code: string, requestId: string): Promise<string> {
  return sha256Hex(`${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}:${requestId}`)
}

/** Who a live code belongs to, without spending it. */
export async function peekConnectCode(
  db: D1Database,
  code: string,
  requestId: string,
  now: number,
): Promise<{ email: string } | null> {
  return db
    .prepare(
      `SELECT u.email AS email FROM mcp_connect_codes c
       JOIN users u ON u.id = c.user_id
       WHERE c.code_hash = ?1 AND c.used_at IS NULL AND c.expires_at > ?2`,
    )
    .bind(await hashConnectCode(code, requestId), now)
    .first<{ email: string }>()
}

/** Spend a code: unused, unexpired, matched by hash. Null when it is none of those. */
export async function redeemConnectCode(
  db: D1Database,
  code: string,
  requestId: string,
  now: number,
): Promise<{ userId: string } | null> {
  const row = await db
    .prepare(
      `UPDATE mcp_connect_codes SET used_at = ?1
       WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING user_id`,
    )
    .bind(now, await hashConnectCode(code, requestId))
    .first<{ user_id: string }>()
  return row ? { userId: row.user_id } : null
}
