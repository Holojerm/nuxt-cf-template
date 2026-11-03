// Is an optional layer part of this checkout? The browser suites assert on pages
// and policy that only exist with a layer (billing's /pricing and Paddle hosts);
// a fork that did not vendor it takes those suites as they are, and the
// assertions follow the layer instead of being deleted by hand.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function hasLayer(name: string): boolean {
  return existsSync(fileURLToPath(new URL(`../../layers/${name}`, import.meta.url)))
}
