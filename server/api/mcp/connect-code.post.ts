// The app's step in the MCP worker's sign-in. The worker's /authorize sends a
// browser to /auth/mcp, which calls this: it mints a single-use code for the
// signed-in user, bound to the worker's request, and answers with the worker
// URL that finishes the connection (see server/utils/mcp-connect.ts).
// Auth comes from the global /api/* middleware.

import { ConnectRequestSchema, connectCallbackUrl, mintConnectCode } from '../../utils/mcp-connect'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  // Keyed by user, not IP: a signed-in account minting codes in a loop is the
  // realistic abuse here (each one is a row and a live credential), and users
  // behind one corporate NAT shouldn't rate-limit each other.
  await rateLimit(event, {
    name: 'mcp-connect-code',
    identifier: user.id,
    limit: 10,
    windowSeconds: 300,
  })

  const { request: requestId } = await readValidatedBody(event, ConnectRequestSchema.parse)
  const mcpUrl = useRuntimeConfig(event).public.mcpUrl
  if (!mcpOrigin(mcpUrl)) {
    throw createError({ statusCode: 404, message: 'No MCP server is configured' })
  }

  const code = await mintConnectCode(db, { userId: user.id, requestId })
  return { redirect: connectCallbackUrl(mcpUrl, { requestId, code }) }
})
