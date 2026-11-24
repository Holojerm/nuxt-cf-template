// GET /api/account/identities — the "Sign-in methods" section on /account:
// what is linked, and which configured providers could be linked next.

import { describeOAuthProviders } from '../../../utils/auth-providers'
import { listIdentities } from '../../../utils/user-identities'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const identities = await listIdentities(db, user.id)

  return {
    identities: identities.map((identity) => ({
      provider: identity.provider,
      email: identity.email,
      linkedAt: identity.linkedAt.toISOString(),
    })),
    // Only providers whose button /login would render: linking one that is not
    // configured dead-ends exactly like signing in with it would.
    providers: describeOAuthProviders(useRuntimeConfig(event).oauth)
      .filter((provider) => provider.available)
      .map(({ id, label, icon }) => ({ id, label, icon })),
  }
})
