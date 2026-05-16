// Vitest config — uses @cloudflare/vitest-pool-workers so tests run inside the
// same `workerd` runtime that Cloudflare runs in production. Server-side code
// gets real D1, KV, and R2 bindings via the `cloudflare:test` import, with
// each test file getting its own isolated storage.
//
// Tests live in `test/` (alongside `app/`, `server/`). Co-located *.test.ts
// inside `server/` is also picked up.
//
// Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/

import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  resolve: {
    alias: {
      // Match the `~` alias Nuxt sets up in app/server code, so test imports
      // like `import { ... } from '~/server/db/schema'` resolve correctly.
      '~': fileURLToPath(new URL('./', import.meta.url)),
      '~~': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
