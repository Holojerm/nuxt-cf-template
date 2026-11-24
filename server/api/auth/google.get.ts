// GET /api/auth/google — start + finish Google OAuth.
//
// Register this exact URL in Google Cloud Console → APIs & Services →
// Credentials → OAuth 2.0 Client ID → Authorized redirect URIs:
//
//   https://<your-app>/api/auth/google
//
// Google's userinfo endpoint returns `email_verified`, and unlike GitHub it can
// genuinely be false (Workspace accounts mid-provisioning, some federated
// setups). We check it rather than assuming — see server/utils/oauth-sign-in.ts.
// `sub` is the identity (user_identities.subject): stable for the life of the
// Google account, unlike the address.

import { failOAuth, finishOAuth, withLinkAwareStart } from '../../utils/oauth-callback'

interface GoogleUser {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

export default withLinkAwareStart(
  defineOAuthGoogleEventHandler({
    config: { scope: ['email', 'profile'] },

    async onSuccess(event, { user }) {
      const profile = user as GoogleUser

      return finishOAuth(h3Event(event), {
        profile: {
          provider: 'google',
          subject: String(profile.sub),
          email: profile.email,
          name: profile.name ?? null,
          avatarUrl: profile.picture ?? null,
        },
        emailVerified: profile.email_verified === true,
      })
    },

    onError(event, error) {
      return failOAuth(h3Event(event), 'google', error)
    },
  }),
)
