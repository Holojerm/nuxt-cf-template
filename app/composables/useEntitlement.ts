// The signed-in user's billing state, for the app shell.
//
// Client-only and non-blocking, on the same reasoning as the past-due banner
// it was lifted out of: the default layout renders on every marketing page,
// so the lookup must cost the server render nothing. One GET after hydration
// per full page load — the layout persists across client-side routing, and
// every caller shares this key, so the nav, the avatar menu and the banner are
// one request. Pages that need the state server-rendered (/account, /pricing)
// keep their own `useFetch` under a different key.
//
// The trade: Dashboard and Files appear in the nav a beat after first paint
// for a paying customer. That beats a D1 round-trip on every marketing page.
export function useEntitlement() {
  const { loggedIn } = useUserSession()
  return useFetch('/api/billing/entitlement', {
    key: 'billing:entitlement',
    server: false,
    lazy: true,
    immediate: loggedIn.value,
    watch: [loggedIn],
  })
}
