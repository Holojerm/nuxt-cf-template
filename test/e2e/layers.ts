// How a layer takes part in the browser suite, without core knowing it exists.
//
// A layer with end-to-end specs puts them in `layers/<name>/test/e2e/` and, if
// the shared dev server needs anything for them, an `e2e.config.ts` next to
// them:
//
//   export default {
//     env: { NUXT_PADDLE_WEBHOOK_SECRET: '…' },   // set on the one shared webServer
//     globalSetup: ['./global-setup.ts'],          // warm-ups, run after core's
//     globalTeardown: ['./global-teardown.ts'],    // child rows, run before core's
//   } satisfies LayerE2e
//
// playwright.config.ts reads each one and adds an `e2e-<name>` project for the
// directory. A fork that does not vendor the layer has no such directory, so the
// suite it takes from the template has no billing specs, no Paddle environment
// and no webhook warm-up in it, and nothing to delete or stub.

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LayerE2e {
  /** Environment for the shared dev server. */
  env?: Record<string, string>
  /** Paths relative to the layer's test/e2e/. */
  globalSetup?: string[]
  globalTeardown?: string[]
}

export interface DiscoveredLayerE2e {
  name: string
  /** Absolute path of `layers/<name>/test/e2e`. */
  dir: string
  env: Record<string, string>
  globalSetup: string[]
  globalTeardown: string[]
}

export async function discoverLayerE2e(root: string): Promise<DiscoveredLayerE2e[]> {
  const layersDir = join(root, 'layers')
  if (!existsSync(layersDir)) return []
  const found: DiscoveredLayerE2e[] = []
  for (const name of readdirSync(layersDir).sort()) {
    const dir = resolve(layersDir, name, 'test/e2e')
    if (!existsSync(dir)) continue
    const configFile = join(dir, 'e2e.config.ts')
    const config: LayerE2e = existsSync(configFile)
      ? ((await import(pathToFileURL(configFile).href)) as { default: LayerE2e }).default
      : {}
    found.push({
      name,
      dir,
      env: config.env ?? {},
      globalSetup: (config.globalSetup ?? []).map((path) => resolve(dir, path)),
      globalTeardown: (config.globalTeardown ?? []).map((path) => resolve(dir, path)),
    })
  }
  return found
}
