// The enforcement half of the security headers in nuxt.config.ts.
//
// A Content-Security-Policy is a promise about what the app loads, and the
// expensive failure is not "the policy is too weak" — it is "the policy is
// slightly too strong and something stopped working six weeks ago". PostHog and
// Turnstile both fail *quietly* under a bad CSP: replay simply never appears in
// the dashboard, the sign-up challenge is an empty box. Neither throws anything
// a user reports and neither shows up in a unit test.
//
// So this suite runs a real browser against the real header and fails on any
// violation. It is the reason the policy can be tightened later by someone who
// wasn't here for the original reconnaissance.
//
// ── What this file can and cannot prove ─────────────────────────────────────
// PostHog no-ops without `posthogKey`, and this template ships it empty — so no
// amount of clicking here produces genuine analytics traffic. Rather than claim
// coverage it does not have, this file verifies the vendor *mechanism* directly
// instead of the vendor:
//
//   * `worker-src blob:` — by constructing a Blob worker exactly the way
//     posthog-js/dist/recorder.js does. Fully offline, fully deterministic.
//
// Checkout needs nothing from the policy: Stripe's hosted Checkout is a
// full-page navigation, so /pricing is scanned like any other page and no
// payment host is allowed. test/security-headers.test.ts asserts that against
// the policy string; see shared/security-headers.ts.

import { expect, test } from '@playwright/test'

import { noncedPolicy } from '../../shared/script-nonce'
import { contentSecurityPolicy } from '../../shared/security-headers'
import { recordConsole } from '../lib/console'
import { hasLayer, hasPage, SIGN_IN_PATH } from '../lib/layers'

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

const ROUTES = [
  '/',
  // Billing's page exists only where the layer does.
  ...(hasLayer('billing') ? ['/pricing'] : []),
  SIGN_IN_PATH,
  ...(hasPage('auth/verify') ? [`/auth/verify#token=${DUMMY_TOKEN}`] : []),
]

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
 * looked at. app/plugins/00.zod-jitless.client.ts now sets `z.config({ jitless:
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

// The recorder itself — addInitScript registration, the securitypolicyviolation
// listener, the console/pageerror listeners — lives in test/lib/console.ts now,
// shared with test/e2e/fixtures.ts. `recordConsole` does the recording; this
// file still owns what counts as a failure here.

for (const route of ROUTES) {
  test(`${route} renders with no CSP violation`, async ({ page }) => {
    const recorder = recordConsole(page)
    await recorder.ready

    await page.goto(route)
    // Hydration and lazily-imported chunks load after first paint, and a chunk
    // is exactly the kind of thing a wrong `script-src` refuses.
    await page.waitForLoadState('networkidle')

    // Every violation counts, eval included — nothing is filtered out here.
    const blocking = await recorder.cspViolations()

    // Some blocks (a refused worker, a refused eval) surface only on the
    // console, so both channels are watched and both are fatal. No exception
    // for `unsafe-eval` messages any more — the zod probe that produced the
    // only benign ones is disabled at source. See the note above.
    const cspConsoleErrors = recorder.messages
      .filter((m) => m.type() === 'error' && /content security policy/i.test(m.text()))
      .map((m) => m.text())

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

test.describe('the web app manifest (Finding 14)', () => {
  // No `manifest-src` directive is set in nuxt.config.ts, so it falls back to
  // `default-src 'self'` — same-origin is already allowed. This is the check
  // that keeps it true: if the manifest or an icon it references ever moved
  // off-origin, "Add to Home Screen" would fail with nothing in this app's own
  // logs to explain why.
  test('/manifest.webmanifest is served with the right content type, and its icons resolve', async ({
    request,
  }) => {
    const manifestResponse = await request.get('/manifest.webmanifest')
    expect(manifestResponse.status()).toBe(200)
    expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json')

    const manifest = await manifestResponse.json()
    expect(manifest.icons.length).toBeGreaterThan(0)

    for (const icon of manifest.icons as { src: string }[]) {
      const iconResponse = await request.get(icon.src)
      expect(iconResponse.status(), `${icon.src} should 200`).toBe(200)
      expect(iconResponse.headers()['content-type']).toContain('image/png')
    }
  })
})

test.describe('the policy still permits what the vendors need', () => {
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
})

// The policy-text assertions (Turnstile and beacon hosts, no payment host, anti-bypass
// directives, no 'unsafe-eval', the script-src host list) are in
// test/security-headers.test.ts. This pins the one thing they cannot see: that
// the server really sends that policy. A rendered page carries it with a nonce for
// script-src's 'unsafe-inline' (shared/script-nonce.ts).
test('the policy on the wire is the one the config defines', async ({ page }) => {
  const response = await page.goto('/')
  const sent = response!.headers()['content-security-policy'] ?? ''
  const nonce = /'nonce-([\w-]+)'/.exec(sent)?.[1] ?? ''
  expect(sent).toBe(noncedPolicy(contentSecurityPolicy(true), nonce))
})

test('a page allows its own inline scripts by nonce, and nothing injected', async ({ page }) => {
  const response = await page.goto('/')
  const policy = response!.headers()['content-security-policy'] ?? ''
  const scriptSrc = /(?:^|; )script-src ([^;]+)/.exec(policy)?.[1] ?? ''
  expect(scriptSrc).not.toContain("'unsafe-inline'")
  const nonce = /'nonce-([\w-]+)'/.exec(scriptSrc)?.[1]
  expect(nonce).toBeTruthy()

  // Every inline script the server rendered carries this page's nonce.
  const html = await response!.text()
  const inline = html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? []
  expect(inline.length).toBeGreaterThan(0)
  for (const tag of inline) expect(tag).toContain(`nonce="${nonce}"`)

  // The page hydrated, so the colour-mode guard and the runtime config ran.
  await expect(page.locator('html')).toHaveClass(/light|dark/)
  expect(await page.evaluate(() => typeof (window as { __NUXT__?: unknown }).__NUXT__)).toBe(
    'object',
  )

  const ran = await page.evaluate(async () => {
    const win = window as unknown as { injected?: boolean }
    document.body.insertAdjacentHTML(
      'beforeend',
      '<img alt="" src="data:," onerror="window.injected = true">',
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    return win.injected === true
  })
  expect(ran).toBe(false)
})
