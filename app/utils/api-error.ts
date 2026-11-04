/**
 * The user-safe message a server route put in `createError()`, or `fallback`.
 * Never a raw fetch/network error, and never a 5xx message — those describe
 * our failure, not something the reader can act on.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const e = error as {
    status?: unknown
    statusCode?: unknown
    data?: { message?: unknown; statusMessage?: unknown; statusCode?: unknown }
  }
  const status = [e.statusCode, e.status, e.data?.statusCode].find((s) => typeof s === 'number')
  if (typeof status === 'number' && status >= 500) return fallback
  for (const candidate of [e.data?.message, e.data?.statusMessage]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return fallback
}
