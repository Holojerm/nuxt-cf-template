// Registers the visitor email list (server/utils/subscribers.ts) with core:
// its public routes, the sweep that deletes addresses that never confirmed, and
// the hand-over when a subscriber creates an account.

import { registerPurgeContributor } from '../utils/extensions'
import { registerPublicApiRoutes } from '../utils/public-routes'
import { registerSignupContributor } from '../utils/signup-contributors'
import { purgePendingSubscribers, removeSubscriberByEmail } from '../utils/subscribers'

export default defineNitroPlugin(() => {
  registerPublicApiRoutes([
    { path: '/api/email/updates', methods: ['POST'] },
    { path: '/api/email/updates/confirm', methods: ['POST'] },
    { path: '/api/email/updates/unsubscribe', methods: ['GET', 'POST'] },
  ])

  registerPurgeContributor({
    key: 'pendingSubscribers',
    run: async (db, options) => ({
      count: await purgePendingSubscribers(db, new Date(options.now ?? Date.now())),
      truncated: false,
    }),
  })

  registerSignupContributor({
    key: 'subscribers',
    afterSignUp: ({ db, user }) => removeSubscriberByEmail(db, user.email),
  })
})
