// Applies the real Drizzle migrations to each test file's isolated D1 before
// its tests run. The migration list is injected as env.TEST_MIGRATIONS by
// vitest.config.ts (readD1Migrations reads server/db/migrations at config time,
// in Node, since workerd has no filesystem).

import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
