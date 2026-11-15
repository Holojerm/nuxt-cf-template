// The layer's pages do not exist until the app turns the layer on.
export default defineNuxtRouteMiddleware(() => {
  if (useRuntimeConfig().public.credentials.enabled) return
  return abortNavigation(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
