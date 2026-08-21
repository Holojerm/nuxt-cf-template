// POST /api/auth/logout — drop the session cookie.
//
// Public by design (it's in the middleware allowlist): signing out an already
// expired session should succeed quietly, not 401 and strand the user on a page
// that thinks they're logged in.
//
// POST, not GET, so a crafted <img src="/api/auth/logout"> can't sign people
// out. nuxt-auth-utils' session cookie is SameSite=lax, so a cross-site POST
// won't carry it either.

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  await clearUserSession(event)

  if (session.user) {
    await captureServerEvent({ distinctId: session.user.id, event: 'user_signed_out' })
  }

  return { ok: true }
})
