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

    // Blocked either way — but not for the same reason, so not to the same
    // place. A customer in dunning already bought this; sending them to a page
    // that sells it is the product telling them to purchase what they are
    // currently paying for, while the one thing that would fix it (update the
    // card) lives somewhere else entirely.
    //
    // /account is where the payment-failed treatment and the update-card CTA
    // are (app/components/Billing/PastDueAlert.vue). This changes the
    // DESTINATION only: `past_due` is still not in ACTIVE_STATUSES, still has
    // no access, and requireSubscription() still 402s every API route behind
    // it. Weakening the gate here would promise access the server denies.
    if (entitlement.state === 'past_due') {
      return navigateTo({ path: '/account', query: { from: to.path } })
    }
  } catch {
    // A failing entitlement check shouldn't strand a paying customer on a
    // pricing page. Let the page render; its API calls enforce the real gate.
    return
  }

  return navigateTo({ path: '/pricing', query: { from: to.path } })
})
