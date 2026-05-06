// GET /api/health — basic health check endpoint
// Use to verify the deployment is live and D1 is accessible.

import { sql } from 'drizzle-orm'

export default defineEventHandler(async () => {
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
