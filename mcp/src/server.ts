// MCP server factory — one isolated instance per request (createMcpHandler
// requires a factory). Register your tools here.

import { McpServer } from '@modelcontextprotocol/server'
import { getMcpAuthContext } from 'agents/mcp/server'
import { z } from 'zod'
import type { AuthProps, Env } from './env'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** The authenticated user's id, from the props sealed into the OAuth grant. */
function authedUserId(): string | null {
  const auth = getMcpAuthContext()
  const props = auth?.props as AuthProps | undefined
  return props?.userId ?? null
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'my-app-mcp', version: '0.1.0' })

  server.registerTool(
    'whoami',
    { description: 'Show the authenticated user this MCP connection acts as' },
    async () => {
      const userId = authedUserId()
      if (!userId) return text('Not authenticated.')
      const user = await env.DB.prepare('SELECT email, name FROM users WHERE id = ?1')
        .bind(userId)
        .first<{ email: string; name: string }>()
      return text(user ? `${user.name} <${user.email}> (${userId})` : `Unknown user ${userId}`)
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
      const userId = authedUserId()
      if (!userId) return text('Not authenticated.')
      const entitlement = await env.DB.prepare(
        `SELECT status, product_key, current_period_end FROM entitlements
         WHERE user_id = ?1 AND product_key = ?2 AND status IN ('active', 'trialing')`,
      )
        .bind(userId, productKey)
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
