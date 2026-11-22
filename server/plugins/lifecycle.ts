// Lifecycle email's one registration with core: the steps due at sign-up are
// sent as the account is created (the welcome), not at the next daily run.

import { lifecycleDeps, sendSignupSteps } from '../utils/lifecycle-runtime'
import { registerSignupContributor } from '../utils/signup-contributors'

export default defineNitroPlugin(() => {
  registerSignupContributor({
    key: 'lifecycle',
    afterSignUpLabel: 'welcome_email',
    afterSignUp: ({ db, event, user }) => sendSignupSteps(db, user, lifecycleDeps(event)),
  })
})
