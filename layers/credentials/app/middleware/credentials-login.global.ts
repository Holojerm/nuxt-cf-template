// When passwords and passkeys are the app's only door (`primary`), /login is
// this layer's sign-in page. Core's guards keep sending people to /login
// (app/middleware/auth.ts), so nothing in core has to learn the new path.
export default defineNuxtRouteMiddleware((to) => {
  const { enabled, primary } = useRuntimeConfig().public.credentials
  if (enabled && primary && to.path === '/login') {
    return navigateTo({ path: '/auth/sign-in', query: to.query }, { replace: true })
  }
})
