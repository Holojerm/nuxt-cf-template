// GET /api/auth/providers — which sign-in buttons should /login render?
//
// The credentials live in server-only runtime config, but the login page needs
// to know which ones are actually configured, or a fresh fork shows a Google
// button that dead-ends in nuxt-auth-utils' "missing configuration" error. This
// route reports availability without ever exposing a client id or secret.

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  const oauth = config.oauth ?? {}

  return {
    providers: [
      {
        id: 'github',
        label: 'GitHub',
        icon: 'i-lucide-github',
        available: Boolean(oauth.github?.clientId && oauth.github?.clientSecret),
      },
      {
        id: 'google',
        label: 'Google',
        icon: 'i-lucide-chrome',
        available: Boolean(oauth.google?.clientId && oauth.google?.clientSecret),
      },
    ],
    // The dev-only email shortcut (server/api/auth/dev.post.ts). Compile-time
    // constant, so this is plain `false` in a production bundle.
    devSignIn: import.meta.dev,
  }
})
