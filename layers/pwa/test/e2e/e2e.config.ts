// Push needs VAPID keys before any of its routes exist. The browser suites
// make a pair for the one dev server they share, so the settings page shows
// the notifications switch and the spec here can drive it. Made fresh per run:
// no key is committed, and nothing is ever sent with these.
import type { LayerE2e } from '../../../../test/e2e/layers'
import { generateVapidKeys } from '../../server/utils/push-crypto'

const keys = await generateVapidKeys()

export default {
  env: {
    NUXT_PWA_VAPID_PRIVATE_KEY: keys.privateKey,
    NUXT_PUBLIC_PWA_VAPID_PUBLIC_KEY: keys.publicKey,
  },
  globalTeardown: ['./global-teardown.ts'],
} satisfies LayerE2e
