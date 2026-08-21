// Route middleware: signed-in users only.
//
//   definePageMeta({ middleware: 'auth' })
//
// This is a UX guard, not a security boundary. It runs in the browser, where
// anyone can skip it. The actual boundary is server/middleware/auth.ts, which
// 401s any /api/ route without a session — so a page that slips past this one
// renders empty rather than leaking data.
//
// Preserves where they were going in `?redirect=`, which /login stashes in a
// cookie before bouncing to the provider (the OAuth round trip drops query
// params, so the cookie is the only thing that survives it).

export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()
  if (loggedIn.value) return

  return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
})
