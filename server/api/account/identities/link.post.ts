// POST /api/account/identities/link — start linking a provider to the signed-in
// account. Sets the signed link-intent cookie and answers with the provider's
// start URL for the page to navigate to (server/utils/identity-link.ts).
//
// A POST behind the session, never a GET: the session cookie is SameSite=Lax,
// so another site can neither start this nor choose which user it names.

import { z } from 'zod'
import { describeOAuthProviders } from '../../../utils/auth-providers'
import { setLinkIntentCookie } from '../../../utils/identity-link'
import { LINK_START_PARAM } from '../../../utils/oauth-callback'

const bodySchema = z.object({ provider: z.string().min(1).max(32) })

export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const { provider } = await readValidatedBody(event, bodySchema.parse)

  const config = useRuntimeConfig(event)
  const available = describeOAuthProviders(config.oauth).some(
    (candidate) => candidate.id === provider && candidate.available,
  )
  if (!available) {
    throw createError({
      statusCode: 400,
      message: 'That sign-in method is not available.',
      data: { code: 'provider_unavailable' },
    })
  }
  if (!config.sessionPassword) {
    // The intent is signed with it; unsigned, it would name whoever it was edited to.
    throw createError({ statusCode: 503, message: 'Linking is not configured.' })
  }

  await setLinkIntentCookie(event, config.sessionPassword, {
    userId: session.user.id,
    provider,
    issuedAt: session.issuedAt,
  })

  return { url: `/api/auth/${provider}?${LINK_START_PARAM}=1` }
})
