// GET /api/auth/github — start + finish the GitHub OAuth dance.
//
// One route handles both legs: no `code` in the query means "redirect to
// GitHub", a `code` means "this is the callback". So the URL to register in
// GitHub → Settings → Developer settings → OAuth Apps → Authorization callback
// URL is exactly:
//
//   https://<your-app>/api/auth/github
//
// Lives under /api/auth/ (no underscore), which server/middleware/auth.ts
// allowlists — the session doesn't exist yet, so the guard must not run.
//
// `emailRequired` makes nuxt-auth-utils fetch /user/emails and pick the primary
// address, because GitHub returns `email: null` for anyone who hid it in their
// profile — which is most people.

interface GitHubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  /** Set by nuxt-auth-utils when it resolves the primary address. */
  email_verified?: boolean
}

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true, scope: ['user:email'] },

  async onSuccess(event, { user }) {
    const profile = user as GitHubUser

    return completeOAuthSignIn(event, {
      profile: {
        provider: 'github',
        email: profile.email ?? '',
        name: profile.name ?? profile.login,
        avatarUrl: profile.avatar_url,
      },
      // GitHub only ever hands back a *primary* address here, and primary
      // addresses must be verified to be set — but when the account exposes a
      // public profile email nuxt-auth-utils takes that path and never sets the
      // flag. Treat a missing flag as verified only for the profile-email case,
      // which GitHub also requires to be verified.
      emailVerified: profile.email_verified !== false,
    })
  },

  onError(event, error) {
    console.error(
      JSON.stringify({ kind: 'oauth_failed', provider: 'github', message: error.message }),
    )
    return redirectToLoginError(event, 'provider_error')
  },
})
