// The enforcement half of the security headers in nuxt.config.ts.
//
// A Content-Security-Policy is a promise about what the app loads, and the
// expensive failure is not "the policy is too weak" — it is "the policy is
// slightly too strong and something stopped working six weeks ago". PostHog and
// Paddle both fail *quietly* under a bad CSP: replay simply never appears in the
// dashboard, checkout simply never opens. Neither throws anything a user reports
// and neither shows up in a unit test.
//
// So this suite runs a real browser against the real header and fails on any
// violation. It is the reason the policy can be tightened later by someone who
// wasn't here for the original reconnaissance.
//
// ── What this file can and cannot prove ─────────────────────────────────────
// PostHog no-ops without `posthogKey` and Paddle no-ops without
// `paddleClientToken`, and this template ships both empty — so no amount of
// clicking here produces genuine analytics or checkout traffic. Rather than
// claim coverage it does not have, this file verifies the two vendor
// *mechanisms* directly instead of the vendors:
//
//   * `worker-src blob:` — by constructing a Blob worker exactly the way
//     posthog-js/dist/recorder.js does. Fully offline, fully deterministic.
//   * `script-src https://cdn.paddle.com` — by actually loading paddle.js and
//     distinguishing a CSP refusal from a network failure, so a flaky CDN
//     cannot turn into a red build.
//
// Everything beyond that (which Paddle host serves the overlay iframe, which
// host the checkout fetches) is asserted against the policy string, having been
// read out of Paddle's shipped bundle. See nuxt.config.ts for that derivation.

import { expect, test } from '@playwright/test'

/**
 * Landing, the checkout entry point, and the auth surface — both halves of the
 * latter, since /auth/verify is the only page that fetches on mount and
 * `connect-src` is the directive nobody notices breaking until sign-in stops.
 *
 * /auth/verify carries a syntactically valid dummy token on purpose. Visited
 * bare, the page short-circuits to its "no token" state and never issues the
 * lookup — so the route was in this list while exercising none of the
 * connect-src it was added to cover. The token is 43 base64url characters, the
 * shape MAGIC_LINK_TOKEN_PATTERN accepts, so the request is really made and
 * really answered (with `invalid`, which is the correct answer and irrelevant
 * here — what matters is that the browser was allowed to ask).
 *
 * In the fragment, because that is where a real link puts it.
 */
const DUMMY_TOKEN = 'A'.repeat(43)

const ROUTES = ['/', '/pricing', '/login', `/auth/verify#token=${DUMMY_TOKEN}`]

interface CspViolation {
  directive: string
  blockedURI: string
  sourceFile: string
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[]
  }
}

/**
 * ── `eval` refusals are fatal, and used not to be ────────────────────────────
 *
 * Zod v4 feature-probed for its JIT compiler by calling `new Function("")`
 * inside a try/catch. This policy refuses it; zod caught the throw and fell
 * back to its interpreter, so validation was correct either way — but the
 * refusal was still *reported*, as a securitypolicyviolation and a console
 * error, on every page load for every visitor. This file used to filter those
 * out so CI stayed green.
 *
 * Tolerating it was the wrong end to fix. The noise landed in every PostHog
 * session replay, where a benign refusal is indistinguishable from a real one —
 * so the first genuine CSP failure this app ever had would be the one nobody
 * looked at. app/plugins/zod-jitless.client.ts now sets `z.config({ jitless:
 * true })`, which is zod's own switch for exactly this case, and the probe no
 * longer happens.
 *
 * With the source of the only known-benign eval refusal gone, the tolerance
 * goes too: an eval violation is now a genuine regression — something new is
 * calling `eval`/`new Function`, or the plugin stopped running — and it fails
 * like any other violation. That is the point of removing it. If this starts
 * failing, find what is evaluating code; do NOT add `'unsafe-eval'`, which the
 * assertion at the bottom of this file exists to prevent.
 */

/**
 * Installs a violation recorder at document_start.
 *
 * It has to be `addInitScript` rather than a listener attached after `goto`:
 * the framework's own inline scripts run before any assertion could attach one,
 * and those are precisely the scripts most likely to be blocked. Playwright
 * injects this through CDP, so it is not itself subject to the page's CSP.
 */
async function recordViolations(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const store: CspViolation[] = []
    window.__cspViolations = store
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: `${event.sourceFile ?? '?'}:${event.lineNumber ?? 0}`,
      })
    })
  })
}

for (const route of ROUTES) {
  test(`${route} renders with no CSP violation`, async ({ page }) => {
    await recordViolations(page)

    // Some blocks (a refused worker, a refused eval) surface only on the
    // console, so both channels are watched and both are fatal.
    const cspConsoleErrors: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      // No exception for `unsafe-eval` messages any more — the zod probe that
      // produced the only benign ones is disabled at source. See the note above.
      if (message.type() === 'error' && /content security policy/i.test(text)) {
        cspConsoleErrors.push(text)
      }
    })

    await page.goto(route)
    // Hydration and lazily-imported chunks load after first paint, and a chunk
    // is exactly the kind of thing a wrong `script-src` refuses.
    await page.waitForLoadState('networkidle')

    // Every violation counts, eval included — nothing is filtered out here.
    const blocking = await page.evaluate(() => window.__cspViolations ?? [])

    expect(
      blocking.map((v) => `${v.directive} blocked ${v.blockedURI} (${v.sourceFile})`),
      `CSP violations on ${route}. Either the page is loading something new, or ` +
        'the policy in nuxt.config.ts needs the source added — decide which before loosening it.',
    ).toEqual([])
    expect(cspConsoleErrors, `CSP console errors on ${route}`).toEqual([])
  })
}

test.describe('the headers are actually on the wire', () => {
  test('every security header is present on a document response', async ({ page }) => {
    const response = await page.goto('/')
    const headers = response!.headers()

    expect(headers['content-security-policy']).toBeTruthy()
    expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['x-content-type-options']).toBe('nosniff')

    // Not preload. It is a submission to a browser-vendor registry that is slow
    // and painful to reverse, so it stays the app owner's decision — if this
    // ever starts failing, someone added it on a domain that may not be ready.
    expect(headers['strict-transport-security']).not.toContain('preload')
  })

  test('the headers cover non-document routes too', async ({ request }) => {
    // routeRules is '/**', and nosniff on assets plus HSTS on API calls are the
    // reason. A narrower pattern would silently drop exactly these.
    const response = await request.get('/api/auth/providers')
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['strict-transport-security']).toBeTruthy()
  })
})

test.describe('the policy still permits what the vendors need', () => {
  /** The whole policy string, read off a live response. */
  async function policy(page: import('@playwright/test').Page): Promise<string> {
    const response = await page.goto('/')
    return response!.headers()['content-security-policy'] ?? ''
  }

  test('a Blob web worker is allowed — PostHog session replay depends on it', async ({ page }) => {
    await page.goto('/')

    // posthog-js builds its rrweb packer worker as
    // `new Worker(URL.createObjectURL(blob))`. Under a policy without
    // `worker-src blob:` the constructor throws and replay is silently absent
    // from the dashboard — nothing in the app errors.
    const outcome = await page.evaluate(async () => {
      try {
        const blob = new Blob(['self.onmessage = () => self.postMessage("ok")'], {
          type: 'text/javascript',
        })
        const worker = new Worker(URL.createObjectURL(blob))
        return await new Promise<string>((resolve) => {
          worker.onmessage = (event) => resolve(String(event.data))
          worker.onerror = () => resolve('worker-error')
          worker.postMessage('ping')
          setTimeout(() => resolve('timeout'), 5000)
        })
      } catch (error) {
        return `threw: ${String(error)}`
      }
    })

    expect(outcome, 'a Blob worker was refused — check worker-src/child-src').toBe('ok')
  })

  test('script-src does not block Paddle.js', async ({ page }) => {
    await recordViolations(page)
    await page.goto('/')

    // Distinguishing a CSP refusal from a flaky CDN matters: only the first is
    // this repo's bug. A refusal fires securitypolicyviolation; a network
    // failure fires onerror with no violation recorded.
    const outcome = await page.evaluate(async () => {
      const src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
      const blocked = () =>
        (window.__cspViolations ?? []).some((v) => v.blockedURI.includes('cdn.paddle.com'))

      return await new Promise<string>((resolve) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => resolve('loaded')
        script.onerror = () => resolve(blocked() ? 'csp-blocked' : 'network-error')
        document.head.appendChild(script)
        setTimeout(() => resolve(blocked() ? 'csp-blocked' : 'timeout'), 15000)
      })
    })

    expect(outcome, 'script-src refused Paddle.js — checkout would never open').not.toBe(
      'csp-blocked',
    )
    // A CDN outage is not this repo's failure, but it does mean this run proved
    // less than it looks like it did, so say so in the report rather than pass silently.
    if (outcome !== 'loaded') {
      test.info().annotations.push({
        type: 'warning',
        description: `paddle.js did not load (${outcome}); CSP was not the cause, but this assertion was not exercised.`,
      })
    }
  })

  test('the Paddle checkout hosts are allowlisted in both environments', async ({ page }) => {
    // The overlay iframe and its API calls cannot be exercised without a client
    // token, so these are asserted against the policy text. The hosts come from
    // the env table inside Paddle's own bundle (checkoutFrontEndBase / apiBase),
    // not from documentation prose — see nuxt.config.ts.
    const csp = await policy(page)

    const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1] ?? ''
    expect(frameSrc).toContain('https://buy.paddle.com')
    expect(frameSrc, 'sandbox is the template default — breaking it breaks first-run').toContain(
      'https://sandbox-buy.paddle.com',
    )

    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1] ?? ''
    expect(connectSrc).toContain('https://api.paddle.com')
    expect(connectSrc).toContain('https://sandbox-api.paddle.com')
  })

  test('Turnstile has both directives it needs, before anyone configures it', async ({ page }) => {
    // Asserted against the policy text rather than by loading a widget, and the
    // reason is the thing worth guarding: this template ships with an empty
    // `turnstile.siteKey`, so <NuxtTurnstile> never renders here and no browser
    // check could exercise these hosts. The day someone pastes a real key in,
    // the CSP has to already be right — a missing host shows up as an empty box
    // on a signup form in production, which is precisely the failure this whole
    // suite exists to make impossible.
    //
    // Two directives, one host, both required: script-src for the api.js loader,
    // frame-src for the challenge iframe it mounts. Getting only the first is
    // the common mistake, and it fails *after* the script loads — so it looks
    // like a Turnstile bug rather than a policy one.
    const csp = await policy(page)

    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? ''
    expect(scriptSrc, 'the Turnstile loader would be refused').toContain(
      'https://challenges.cloudflare.com',
    )

    const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1] ?? ''
    expect(frameSrc, 'the challenge iframe would be refused').toContain(
      'https://challenges.cloudflare.com',
    )
  })

  test('PostHog stays on the first-party proxy', async ({ page }) => {
    const csp = await policy(page)

    // The SDK is pinned to `api_host: '/ingest'` and server/routes/ingest
    // reverse-proxies everything, which is what survives ad blockers. A
    // posthog.com origin appearing here means someone "fixed" a violation by
    // punching through the proxy instead of repairing it — the analytics would
    // work in dev and be dropped for a third of real users.
    expect(csp, 'a *.posthog.com origin in the CSP defeats the /ingest proxy').not.toContain(
      'posthog.com',
    )

    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1] ?? ''
    expect(connectSrc).toContain("'self'")
  })
})

test.describe('the directives that make the policy worth having', () => {
  test('the anti-bypass directives are locked down', async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''

    // script-src carries 'unsafe-inline' (nuxt.config.ts explains why it has to),
    // and these three are what keep that from being a blank cheque: object-src
    // and base-uri are the two classic ways to bypass a script-src, and
    // form-action stops an injected form from posting credentials off-origin.
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'self'")
  })

  test("eval stays blocked — 'unsafe-eval' must never be added", async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''

    // The counterweight to isEvalProbe at the top of this file. That predicate
    // tolerates zod's *reported* eval refusal; this one proves the refusal is
    // still happening. The tempting "fix" for a noisy console is to add
    // 'unsafe-eval' here — which converts a harmless report into a genuine
    // capability for anything that achieves script injection. If both this
    // assertion and that predicate are ever relaxed together, the suite would
    // go green having verified nothing.
    expect(
      csp,
      "'unsafe-eval' re-enables the exact class of attack this policy exists to stop",
    ).not.toContain('unsafe-eval')
  })

  test('no external origin has crept into script-src beyond the two we chose', async ({ page }) => {
    const response = await page.goto('/')
    const csp = response!.headers()['content-security-policy'] ?? ''
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? ''

    // The guard that makes this suite worth running after everyone has left:
    // adding a tag manager, a chat widget or a font CDN means adding a host
    // here, and that should be a decision someone makes on purpose.
    //
    // challenges.cloudflare.com joined the list when Turnstile did, and that is
    // this assertion working rather than being worked around: the list is short
    // enough to read, and every entry on it had to be argued for in
    // nuxt.config.ts. Do not append to it to make a build go green.
    const externalHosts = scriptSrc
      .split(/\s+/)
      .filter((source) => source.startsWith('http') || source.startsWith('//'))

    expect(externalHosts.sort()).toEqual([
      'https://cdn.paddle.com',
      'https://challenges.cloudflare.com',
      'https://sandbox-cdn.paddle.com',
    ])
  })
})
