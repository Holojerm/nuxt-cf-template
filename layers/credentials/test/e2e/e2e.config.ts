// The layer ships off. The browser suites turn it on for the one dev server
// they share, with PRF requested, so its pages answer 200 for the axe sweep and
// the spec here can drive them. `primary` stays false: /login is still core's.
import type { LayerE2e } from '../../../../test/e2e/layers'

export default {
  env: {
    NUXT_PUBLIC_CREDENTIALS_ENABLED: 'true',
    NUXT_PUBLIC_CREDENTIALS_PRF: 'true',
  },
  globalTeardown: ['./global-teardown.ts'],
} satisfies LayerE2e
