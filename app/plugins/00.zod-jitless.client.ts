// Stop zod probing for `eval` in the browser.
//
// ── The symptom ──────────────────────────────────────────────────────────────
// Zod v4 feature-detects its JIT compiler by calling `new Function("")` inside
// a try/catch. Our CSP has no `'unsafe-eval'`, so the browser refuses it. Zod
// catches the throw and falls back to its interpreter — validation is correct
// either way — but the refusal is still *reported*: a `securitypolicyviolation`
// event plus a red console error, on every page, for every visitor.
//
// That noise is not harmless. It lands in every PostHog session replay, where
// it is indistinguishable from a real CSP failure, so the first genuine
// violation this app ever has will be the one nobody looks at.
//
// ── The fix, and why it is this one ─────────────────────────────────────────
// `jitless` is zod's own switch for exactly this case. From
// node_modules/zod/v4/core/util.js:
//
//     // Skip the probe under `jitless`: strict CSPs report the caught
//     // `new Function` as a `securitypolicyviolation` even though the
//     // throw is swallowed.
//
// The alternative — adding `'unsafe-eval'` to script-src — would re-open the
// single most valuable thing the policy closes in order to quiet a probe that
// is *designed* to be refused. test/csp/csp.spec.ts asserts that never happens.
//
// ── Why module scope, and why the `00.` ─────────────────────────────────────
// Both are load-bearing, and the second one cost a red CI run to find.
//
// The probe fires when an object schema is *constructed*, not when it first
// parses: schemas.js reads `allowsEval.value` while building the parse path,
// and `allowsEval` is memoised on first read. So the flag has to be set before
// the first `z.object(...)` in the app is evaluated — which rules out doing
// this inside the setup function below, because by then plugin modules have all
// been imported.
//
// Module scope alone is still not enough. Nuxt registers `app/plugins/*` in
// ALPHABETICAL order and imports them in that order, and `attribution.client.ts`
// pulls in shared/utils/attribution.ts, which builds `attributionSchema` at ITS
// module scope. Named `zod-jitless.client.ts` this file sorted last, the
// attribution schema was constructed first, and the probe had already run and
// been memoised by the time `z.config()` executed — the plugin ran, logged, and
// did nothing. The numeric prefix is Nuxt's documented ordering mechanism and is
// what actually makes this work. Do not rename it without checking
// `bunx playwright test --project=csp`, which is the thing that catches it.
//
// ── Why .client only ─────────────────────────────────────────────────────────
// There is no CSP on the server, and zod already skips the probe on workerd
// (it sniffs the Cloudflare user agent). Disabling the JIT there would cost
// throughput to fix a problem that only exists in a browser.
//
// The cost here is a slower validation path for large schemas. Ours are login
// forms and an admin search box; the interpreter is not the bottleneck.

import { z } from 'zod'

z.config({ jitless: true })

export default defineNuxtPlugin(() => {
  // Nothing to do at setup — the line above already ran. The plugin exists so
  // Nuxt evaluates this module as part of the client entry.
})
