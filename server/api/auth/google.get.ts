// GET /api/auth/google — start + finish Google OAuth.
//
// Register this exact URL in Google Cloud Console → APIs & Services →
// Credentials → OAuth 2.0 Client ID → Authorized redirect URIs:
//
//   https://<your-app>/api/auth/google
//
// Google's userinfo endpoint returns `email_verified`, and unlike GitHub it can
// genuinely be false (Workspace accounts mid-provisioning, some federated
// setups). We check it rather than assuming — see completeOAuthSignIn.

interface GoogleUser {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

export default defineOAuthGoogleEventHandler({
  config: { scope: ['email', 'profile'] },

  async onSuccess(event, { user }) {
    const profile = user as GoogleUser

    return completeOAuthSignIn(event, {
      profile: {
        provider: 'google',
        email: profile.email,
        name: profile.name ?? null,
        avatarUrl: profile.picture ?? null,
      },
      emailVerified: profile.email_verified === true,
    })
  },

  onError(event, error) {
    console.error(
      JSON.stringify({ kind: 'oauth_failed', provider: 'google', message: error.message }),
    )
    return redirectToLoginError(event, 'provider_error')
  },
})
