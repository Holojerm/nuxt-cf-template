// GET /api/health — basic health check endpoint
// Use to verify the deployment is live and D1 is accessible.

import { sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  // Public and unauthenticated, so it's the cheapest way to make the Worker do
  // a D1 query on demand. Generous enough for any real monitor (uptime checks
  // poll at 30–60s), tight enough that it isn't a free load generator.
  await rateLimit(event, { name: 'health', limit: 60, windowSeconds: 60 })

  try {
    // Lightweight query to confirm D1 connectivity
    // `db` is auto-imported by @nuxthub/core
    await db.run(sql`SELECT 1`)

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    }
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Database unavailable',
    })
  }
})
