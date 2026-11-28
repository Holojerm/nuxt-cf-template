import type { drizzle } from 'drizzle-orm/d1'

import type * as tables from '../db/schema'

/**
 * The Drizzle client the push code takes: one that knows at least this layer's
 * tables, so the app's `db` fits and so does a plain Worker's
 * `drizzle(env.DB, { schema })`. Typed from the layer's own schema rather than
 * `ExtensionDb`, which would pull the app's server utils (and Nitro) into
 * that Worker's program.
 */
export type PushDb = ReturnType<typeof drizzle<typeof tables>>
