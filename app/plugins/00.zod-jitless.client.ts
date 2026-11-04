// Zod v4 probes for eval with `new Function("")`; our CSP (no 'unsafe-eval') refuses it and
// reports a violation on every page, which buries real CSP failures in session replays.
// `jitless` skips the probe; the alternative, 'unsafe-eval', would open the policy's biggest hole.
//
// Module scope and the `00.` prefix are load-bearing: the probe is memoised when the first
// object schema is constructed, and Nuxt imports plugins alphabetically (attribution.client.ts
// builds a schema at import). `bunx playwright test --project=csp` catches a wrong order.
// Client only: there is no CSP on the server, and zod already skips the probe on workerd.

import { z } from 'zod'

z.config({ jitless: true })

export default defineNuxtPlugin(() => {})
