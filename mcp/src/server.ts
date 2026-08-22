// MCP server factory — one isolated instance per request (createMcpHandler
// requires a factory). Register your tools here.

import { McpServer } from '@modelcontextprotocol/server'
import { getMcpAuthContext } from 'agents/mcp/server'
import { z } from 'zod'
import type { AuthProps, Env } from './env'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** The props sealed into the OAuth grant this request is acting under. */
function authProps(): AuthProps | null {
  const auth = getMcpAuthContext()
  return (auth?.props as AuthProps | undefined) ?? null
}

/**
 * Is this address a deleted-account tombstone?
 *
 * ── Mirrored, not imported, and that is a liability worth naming ─────────────
 * The source of truth is `isUndeliverableAddress()` in
 * `server/utils/users.ts`. This worker is a separate Cloudflare Worker with its
 * own build and its own package.json; it cannot import the app's TypeScript, and
 * it deliberately carries no Drizzle schema (see subscription_status below,
 * which re-expresses findActiveEntitlement() in raw SQL for the same reason).
 * So the rule is written twice. If you change one, change the other.
 *
 * The rule: RFC 2606 reserves `.invalid` so that it can never resolve, and
 * account deletion rewrites the row's email to `deleted-<id>@deleted.invalid`.
 * Refusing the whole TLD costs zero real users and survives the tombstone's
 * exact spelling changing. `.example` is deliberately NOT included — this repo's
 * fixtures and its dev sign-in run on it.
 */
function isTombstoneAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').pop() ?? ''
  return domain === 'invalid' || domain.endsWith('.invalid')
}

interface AuthorizedUser {
  id: string
  email: string
  name: string
}

/**
 * The user this request may act as, or null if it may not act at all.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * An OAuth grant lives in this worker's OAUTH_KV. The app has no handle on that
 * namespace, so deleting an account cannot revoke a grant — it does not know any
 * exist. Deletion anonymizes the `users` row in place (the id has to survive:
 * `entitlements.user_id` is a real foreign key), so before this check a grant
 * issued to a since-deleted account kept working indefinitely, reading the
 * tombstone row and answering tool calls against it.
 *
 * Two refusals, deliberately the same two as `checkSession()` in
 * `server/utils/session-guard.ts`, so the worker and the app agree on who is
 * allowed to act:
 *
 *   tombstone   The row's email is `.invalid`. Cheap — the email is already in
 *               the row being read — and it holds even if some future code path
 *               forgets to set the watermark.
 *   revoked /   The account has a `sessions_invalid_before` watermark and this
 *   undated     grant either predates it or cannot say. "Cannot say" is a
 *               refusal on purpose: a grant with no `grantedAt` is one issued
 *               before that field existed, and waving those through would mean
 *               the one class of credential an attacker would most like to hold
 *               is the class the check skips. Accounts that have never revoked
 *               anything have a NULL watermark and are untouched, so adding this
 *               disconnects nobody.
 *
 * One indexed primary-key read per tool call, same trade the app's session guard
 * makes and rejected a cache for, for the same reason: a cached "still valid"
 * reintroduces the bug for the length of the TTL.
 */
async function loadAuthorizedUser(env: Env): Promise<AuthorizedUser | null> {
  const props = authProps()
  if (!props?.userId) return null

  const row = await env.DB.prepare(
    'SELECT email, name, sessions_invalid_before FROM users WHERE id = ?1',
  )
    .bind(props.userId)
    .first<{ email: string; name: string; sessions_invalid_before: number | null }>()

  if (!row) return null
  if (isTombstoneAddress(row.email)) return null

  const watermark = row.sessions_invalid_before
  if (watermark !== null) {
    // Seconds on both sides. Drizzle writes that column in `mode: 'timestamp'`,
    // which is epoch seconds, and authorize.ts stamps `grantedAt` in seconds to
    // match. `<` rather than `<=`, like the app: a credential issued in the same
    // second as the revocation is the one the new sign-in just created.
    if (props.grantedAt === undefined) return null
    if (props.grantedAt < watermark) return null
  }

  return { id: props.userId, email: row.email, name: row.name }
}

/** What a refused caller is told. Identical for every reason on purpose. */
const REFUSED = 'This connection is no longer authorized. Reconnect from the app to continue.'

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'my-app-mcp', version: '0.1.0' })

  server.registerTool(
    'whoami',
    { description: 'Show the authenticated user this MCP connection acts as' },
    async () => {
      // One call does the lookup and the authorization check, so there is no
      // way to read the row without having decided the caller may read it.
      const user = await loadAuthorizedUser(env)
      if (!user) return text(REFUSED)
      return text(`${user.name} <${user.email}> (${user.id})`)
    },
  )

  // Example of an entitlement-gated tool: same gate as the app's
  // requireSubscription() (server/utils/billing.ts), expressed as raw D1 SQL
  // since this worker doesn't carry the Drizzle schema.
  server.registerTool(
    'subscription_status',
    {
      description: 'Report the subscription entitlement for the authenticated user',
      inputSchema: { productKey: z.string().default('default') },
    },
    async ({ productKey }) => {
      // Every tool starts here, not with authProps(). A deleted account keeps
      // its entitlement rows — they are billing history — so reading them
      // straight off the grant's userId would report a live subscription for an
      // account that no longer exists.
      const user = await loadAuthorizedUser(env)
      if (!user) return text(REFUSED)
      const userId = user.id
      // This has to mean exactly what findActiveEntitlement() means in the app
      // (server/utils/entitlements.ts), because it is the same gate written
      // twice — the worker has no Drizzle schema, so it cannot call it.
      //
      // Three clauses, and only the first is obvious:
      //   1. status IN ('active','trialing') — ACTIVE_STATUSES. `past_due` is
      //      deliberately absent: access is paused for the whole of dunning.
      //   2. `sub_` rows pass on status ALONE. Paddle owns their lifecycle and
      //      flips the status when they end, so their date is not a gate.
      //   3. EVERYTHING ELSE must still be in its window. `txn_` passes and
      //      `comp_` grants never receive a lifecycle event, so status stays
      //      'active' forever and the date is the only thing that ends them.
      //      Without this clause an expired pass granted MCP access for good.
      //
      // `\_` is escaped because `_` is a LIKE wildcard — unescaped, `sub_%`
      // also matches `subs_fake`, which would put an arbitrary ref onto the
      // never-expires branch. Same reasoning as server/utils/sql.ts.
      //
      // current_period_end is epoch SECONDS (note the *1000 below), so the
      // comparison is against seconds, not Date.now().
      const nowSeconds = Math.floor(Date.now() / 1000)
      const entitlement = await env.DB.prepare(
        `SELECT status, product_key, current_period_end FROM entitlements
         WHERE user_id = ?1 AND product_key = ?2 AND status IN ('active', 'trialing')
           AND (paddle_subscription_id LIKE 'sub\\_%' ESCAPE '\\'
                OR current_period_end > ?3)
         ORDER BY current_period_end DESC`,
      )
        .bind(userId, productKey, nowSeconds)
        .first<{ status: string; product_key: string; current_period_end: number | null }>()
      if (!entitlement) {
        // The gate: tools behind a paywall should return this and stop.
        return text(`No active subscription for "${productKey}". Subscribe in the app to use this.`)
      }
      const until = entitlement.current_period_end
        ? new Date(entitlement.current_period_end * 1000).toISOString()
        : 'unknown'
      return text(`Subscription "${productKey}" is ${entitlement.status} (period ends ${until}).`)
    },
  )

  return server
}
