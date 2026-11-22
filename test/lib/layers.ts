// Is an optional layer part of this checkout? The browser suites assert on pages
// and policy that only exist with a layer (billing's /pricing and Stripe hosts);
// a fork that did not vendor it takes those suites as they are, and the
// assertions follow the layer instead of being deleted by hand.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function hasLayer(name: string): boolean {
  return existsSync(fileURLToPath(new URL(`../../layers/${name}`, import.meta.url)))
}

/**
 * Does the app have this page? The name is its path under the pages directory, without the extension.
 * A fork that signs in with the credentials layer alone deletes core's sign-in
 * pages (TEARDOWN.md, "Credentials only"), and the browser suites follow.
 */
export function hasPage(name: string): boolean {
  return existsSync(fileURLToPath(new URL(`../../app/pages/${name}.vue`, import.meta.url)))
}

/** Where a signed-out visitor is sent: core's page, or the credentials layer's once that is gone. */
export const SIGN_IN_PATH = hasPage('login') ? '/login' : '/auth/sign-in'
