// GET /api/account/export — the self-serve "copy of your data" /privacy
// promises. Shape and field selection live in server/utils/account.ts
// (exportAccount) so they're testable without booting Nitro; this route only
// adds the things that need an H3 event — auth, rate limiting, and the
// download headers.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  // Keyed by user, not IP, matching the mcp-connect-code limiter — the
  // realistic abuse here is a signed-in account hammering a moderately
  // expensive multi-table read, not a shared corporate NAT.
  await rateLimit(event, {
    name: 'account-export',
    identifier: user.id,
    limit: 10,
    windowSeconds: 600,
  })

  const data = await exportAccount(db, user.id)
  if (!data) throw createError({ statusCode: 404, message: 'Account not found' })

  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${exportFilename(useRuntimeConfig(event).public.appName)}"`,
  )

  return data
})
