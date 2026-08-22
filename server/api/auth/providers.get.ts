// GET /api/auth/providers — which sign-in buttons should /login render?
//
// The credentials live in server-only runtime config, but the login page needs
// to know which ones are actually configured, or a fresh fork shows a Google
// button that dead-ends in nuxt-auth-utils' "missing configuration" error. This
// route reports availability without ever exposing a client id or secret.
//
// The list itself — and the reasoning behind its order — lives in
// server/utils/auth-providers.ts, which is a pure function of config so it can
// be tested without Nitro.

import { describeOAuthProviders } from '../../utils/auth-providers'

export default defineEventHandler(() => {
  const config = useRuntimeConfig()

  return {
    providers: describeOAuthProviders(config.oauth),
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
