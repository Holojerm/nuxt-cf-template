/** Prefix of the cache that holds the offline page. The client plugin deletes by it when the layer is switched off. */
export const PWA_CACHE_PREFIX = 'pwa-offline-'

/**
 * Prefix of the caches that hold what a signed-in person loaded on an offline
 * route: its pages, its data and the build's files. Everything under it is
 * deleted on sign-out and when the signed-in account changes.
 */
export const PWA_PERSONAL_CACHE_PREFIX = 'pwa-personal-'

/** The Background Sync tag and the BroadcastChannel the outbox announces changes on. */
export const PWA_OUTBOX_TAG = 'pwa-outbox'

/**
 * `offlineRoutes` and `offlineApi` as a list of paths. Each can arrive as an
 * array (nuxt.config) or as a string (`NUXT_PUBLIC_PWA_*`: a JSON array is
 * parsed for us, anything else is read as a comma-separated list). An entry
 * that is not a path is dropped, and so is `/`, which would be the whole app.
 */
export function pwaPrefixes(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const paths = entries
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.startsWith('/') && !entry.startsWith('//') && entry !== '/')
  return [...new Set(paths)]
}
