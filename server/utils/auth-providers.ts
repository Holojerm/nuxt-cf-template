// Which sign-in buttons /login should render, as a pure function of config.
//
// Pulled out of server/api/auth/providers.get.ts so it can be tested without
// booting Nitro — and it needs testing, because "is this provider usable?" is
// the check that decides whether someone is shown a button that dead-ends. A
// wrong answer here is a visitor clicking Sign in and landing on
// nuxt-auth-utils' raw "missing configuration" error, or worse, on a provider
// error page after a round trip to Apple.
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

export interface OAuthProviderButton {
  id: string
  label: string
  icon: string
  available: boolean
}

/** The `oauth` block of runtime config, as much of it as this file reads. */
export interface OAuthProviderConfig {
  apple?: {
    clientId?: string
    teamId?: string
    keyId?: string
    privateKey?: string
    redirectURL?: string
  }
  google?: { clientId?: string; clientSecret?: string }
  github?: { clientId?: string; clientSecret?: string }
}

export function describeOAuthProviders(oauth: OAuthProviderConfig = {}): OAuthProviderButton[] {
  return [
    {
      id: 'apple',
      label: 'Apple',
      icon: 'i-lucide-apple',
      // Five values, and every one of them is load-bearing.
      //
      // Apple has no static client secret: the server signs a short-lived ES256
      // JWT per request from a .p8 key, which is where teamId/keyId/privateKey
      // go. `redirectURL` is the one that is easy to leave out and impossible to
      // debug from the symptom. Unlike the Google and GitHub handlers,
      // nuxt-auth-utils' Apple handler (0.5.30,
      // dist/runtime/server/lib/oauth/apple.js) uses the RAW `config.redirectURL`
      // in the token-exchange body instead of falling back to
      // getOAuthRedirectURL(event). Unset, it serialises as the string
      // "undefined", Apple compares it to the registered Return URL, and the
      // whole flow dies at the last step with `invalid_grant` — after a
      // successful trip to Apple, a successful consent screen, and a callback
      // that looked fine. Requiring it here means the button never appears
      // unless the flow can actually complete.
      available: Boolean(
        oauth.apple?.clientId &&
        oauth.apple?.teamId &&
        oauth.apple?.keyId &&
        oauth.apple?.privateKey &&
        oauth.apple?.redirectURL,
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
  ]
}
