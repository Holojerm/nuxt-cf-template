// Remote MCP server worker: workers-oauth-provider wraps the MCP endpoint with
// OAuth 2.1 (dynamic client registration included, so MCP clients can connect
// with just the URL). Point clients at https://<this-worker>/mcp.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { defaultHandler } from './authorize'
import type { Env } from './env'
import { createServer } from './server'

// Fresh handler per request so each one gets an isolated server instance and
// tools see the request's env. ctx.props (set by OAuthProvider from the
// grant) flows through to getMcpAuthContext() in tools.
const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => createServer(env))(request, env, ctx)
  },
}

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
})
