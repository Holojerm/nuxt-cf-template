// Shared browser console / CSP-violation recorder for the Playwright suites.
//
// test/csp/csp.spec.ts and test/e2e/fixtures.ts each grew a near-identical
// copy of this independently: an `addInitScript` that records
// `securitypolicyviolation` events into a window property (has to run via
// `addInitScript` rather than a listener attached after `goto` — a page's
// own inline scripts run before any post-navigation listener could attach,
// and those are precisely the scripts most likely to be blocked), plus a
// `page.on('console', …)` listener. One copy now.
//
// Deliberately thin: this only RECORDS. Each caller still decides what to do
// with what it recorded, because the two existing callers want genuinely
// different things from the same raw stream — csp.spec.ts filters console
// messages for CSP-flavoured text on signed-out routes, test/e2e/fixtures.ts
// treats every console error as fatal (with one counted, documented
// exception) on signed-in ones. Folding that policy in here would force one
// caller's rules onto the other.

import type { ConsoleMessage, Page } from '@playwright/test'

export interface CspViolation {
  directive: string
  blockedURI: string
  sourceFile: string
}

// The window property name is part of this module's public contract, not an
// implementation detail: a caller that needs to read it from INSIDE a
// page.evaluate() callback (test/csp/csp.spec.ts's Paddle.js test does,
// because it has to check for a violation from the same browser-side
// callback that triggered it) has no other way to reach it.
declare global {
  interface Window {
    __cspViolations?: CspViolation[]
  }
}

export interface ConsoleRecorder {
  /** Every console message observed on this page since the recorder was installed. */
  messages: ConsoleMessage[]
  /** Every uncaught exception observed on this page since the recorder was installed. */
  pageErrors: Error[]
  /** Resolves once the CSP-violation init script is guaranteed registered. */
  ready: Promise<void>
  /** CSP violations recorded so far. Awaits `ready` internally. */
  cspViolations(): Promise<CspViolation[]>
}

/**
 * Call once per page, before the first navigation — an init script only
 * covers navigations that happen after it is registered.
 */
export function recordConsole(page: Page): ConsoleRecorder {
  const messages: ConsoleMessage[] = []
  const pageErrors: Error[] = []

  page.on('console', (message) => messages.push(message))
  page.on('pageerror', (error) => pageErrors.push(error))

  const ready = page.addInitScript(() => {
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

  return {
    messages,
    pageErrors,
    ready,
    async cspViolations() {
      await ready
      return page.evaluate(() => window.__cspViolations ?? [])
    },
  }
}
