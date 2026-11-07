// The fork seam for billing's browser specs. The specs are vendored byte for
// byte, so what differs per product (which page is gated, its copy, how a user
// signs in) comes from an optional fork-owned file, test/e2e/billing.e2e.ts:
//
//   import type { BillingE2e } from '../../layers/billing/test/e2e/fork-config'
//   export default { gatedPath: null } satisfies Partial<BillingE2e>
//
// Every key is optional and falls back to the template's value, so with no file
// the specs run exactly as written. See .claude/docs/billing.md "Running the
// layer's e2e in a fork".

import type { APIRequestContext, Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface BillingE2e {
  /**
   * The plan-gated page the specs visit. `null` = the product gates an action
   * (an API route), not a page: page-level assertions (redirects, upsell copy,
   * unlocked content) are skipped, the entitlement-level ones still run.
   */
  gatedPath: string | null
  /** Text the upsell page shows when it sends someone away from `gatedPath`. */
  gatedCopy: string
  /** Where an account with no plan lands (a past_due one lands on /account). */
  upsellPathPrefix: string
  /** Heading proving `gatedPath` rendered for an entitled user; `null` skips it. */
  unlockedHeading: RegExp | null
  /** Extra text on the unlocked page, checked in the one-time-pass case only; `null` skips it. */
  unlockedText: string | null
  /**
   * Sign `user` in on `request` (a fresh context; its cookie jar becomes the
   * session) and return the user id. `null` = the template's POST /api/auth/dev.
   * Takes a request context, not a page, because sign-in is cached per worker to
   * stay under the auth rate limit; the cookies are copied into each test's page.
   */
  signIn:
    | ((
        request: APIRequestContext,
        user: { email: string; name?: string },
      ) => Promise<{ userId: string }>)
    | null
  /**
   * An extra product-level check run wherever a spec asserts access. `granted`:
   * the account was just entitled; `denied`: it has no active plan. Runs in
   * addition to the /api/billing/entitlement check, e.g. woolholm's
   * POST /api/games succeeding or answering 402.
   */
  accessProbe:
    | ((
        ctx: { request: APIRequestContext; page: Page },
        expected: 'granted' | 'denied',
      ) => Promise<void>)
    | null
}

export const DEFAULT_BILLING_E2E: BillingE2e = {
  gatedPath: '/dashboard',
  gatedCopy: 'That page needs an active plan',
  upsellPathPrefix: '/pricing',
  unlockedHeading: /Welcome back/,
  unlockedText: 'Get set up',
  signIn: null,
  accessProbe: null,
}

const FORK_FILE = fileURLToPath(new URL('../../../../test/e2e/billing.e2e.ts', import.meta.url))

async function load(): Promise<BillingE2e> {
  if (!existsSync(FORK_FILE)) return DEFAULT_BILLING_E2E
  const mod = (await import(pathToFileURL(FORK_FILE).href)) as {
    default: Partial<BillingE2e>
  }
  return { ...DEFAULT_BILLING_E2E, ...mod.default }
}

export const billingE2e: BillingE2e = await load()
