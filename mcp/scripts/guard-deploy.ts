// Runs before `wrangler deploy` for this worker, and refuses inside another
// Worker's Workers Build.
//
// A Workers Build belongs to one Worker and forces that Worker's name onto
// every `wrangler deploy` it runs (WRANGLER_CI_OVERRIDE_NAME). A fork once
// chained this package's deploy into the app's build: the MCP worker was
// uploaded under the app's name, replacing the app and detaching its domain,
// and the site answered Cloudflare error 1016 until the app was rolled back and
// its triggers re-deployed by hand (2026-11-18). Deploy this worker from a
// machine, or from a Workers Build of its own with `mcp/` as the root
// directory, where the forced name is this worker's.

import { readFileSync } from 'node:fs'

const forced = process.env.WRANGLER_CI_OVERRIDE_NAME
// The first `"name"` in wrangler.jsonc is the Worker's; binding names come later.
const own = /^\s*"name":\s*"([^"]+)"/m.exec(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
)?.[1]

if (forced && forced !== own) {
  console.error(
    `\nmcp deploy refused: this build deploys the Worker "${forced}", and wrangler would upload ` +
      `the MCP worker under that name, replacing it.\n` +
      `Run \`bun run mcp:deploy\` from a machine, or give "${own}" its own Workers Build ` +
      `(root directory mcp/).\n`,
  )
  process.exit(1)
}
