// Route middleware: paying customers only.
//
//   definePageMeta({ middleware: ['auth', 'subscription'] })
//
// Order matters — `auth` first, so a signed-out visitor gets sent to /login
// rather than to /pricing to buy something they can't attach to an account.
//
// Same caveat as `auth`: this is the UX half. The enforcing half is
// `await requireSubscription(event)` inside the API routes the page calls,
// which 402s without an entitlement. Never gate a paid feature on this file
// alone — the client cannot be trusted with an authorization decision.

export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) return

  // Not useFetch: middleware runs outside a component's setup, so there's no
  // scope to own the request. $fetch on both server and client is correct here.
  try {
    const entitlement = await $fetch('/api/billing/entitlement')
    if (entitlement.active) return
  } catch {
    // A failing entitlement check shouldn't strand a paying customer on a
    // pricing page. Let the page render; its API calls enforce the real gate.
    return
  }

  return navigateTo({ path: '/pricing', query: { from: to.path } })
})
