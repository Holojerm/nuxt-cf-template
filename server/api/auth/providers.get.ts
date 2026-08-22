// GET /api/auth/providers — which sign-in buttons should /login render?
//
// The credentials live in server-only runtime config, but the login page needs
// to know which ones are actually configured, or a fresh fork shows a Google
// button that dead-ends in nuxt-auth-utils' "missing configuration" error. This
// route reports availability without ever exposing a client id or secret.
//
// ── The order of this array is the order on the page, and it is a decision ───
// Magic link is the primary control on /login and is not in this list at all —
// it needs no credentials, so there is nothing to report. What is left are the
// providers, ordered for the audience this app has:
//
//   Apple, Google   Where consumers already have an account. Apple in front on
//                   the strength of iOS, where its button is the one people
//                   expect to see and the one that costs them no typing.
//   GitHub          Last, and off unless someone deliberately configures it.
//
// GitHub is a *developer* credential. Leading a consumer sign-in page with it
// tells most visitors this product is not for them, and it is the single
// clearest tell that a template was never re-aimed after being forked. It stays
// available because plenty of forks of this repo are developer tools, where it
// is exactly right — see .env.example and the README's Auth section.

export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  const oauth = config.oauth ?? {}

  return {
    providers: [
      {
        id: 'apple',
        label: 'Apple',
        icon: 'i-lucide-apple',
        // Four values, not two: Apple's client secret is a JWT signed per
        // request from a .p8 key. See server/api/auth/apple.ts.
        available: Boolean(
          oauth.apple?.clientId &&
          oauth.apple?.teamId &&
          oauth.apple?.keyId &&
          oauth.apple?.privateKey,
        ),
      },
      {
        id: 'google',
        label: 'Google',
        icon: 'i-lucide-chrome',
        available: Boolean(oauth.google?.clientId && oauth.google?.clientSecret),
      },
      {
        id: 'github',
        label: 'GitHub',
        icon: 'i-lucide-github',
        available: Boolean(oauth.github?.clientId && oauth.github?.clientSecret),
      },
    ],
    // Can the magic link actually be delivered? The page needs this because
    // that path is the primary one: a fork deployed without Resend would
    // otherwise render a form whose submit 503s, and the owner would find out
    // from a support email rather than from their own login page.
    //
    // True in dev regardless, because an unconfigured Resend logs the sign-in
    // URL to the server console there instead of sending it — which is a working
    // sign-in path for a fresh clone, just one you read out of the terminal.
    emailSignIn: import.meta.dev || Boolean(config.resend?.apiKey && config.resend?.from),
    // The dev-only email shortcut (server/api/auth/dev.post.ts). Compile-time
    // constant, so this is plain `false` in a production bundle.
    devSignIn: import.meta.dev,
  }
})
