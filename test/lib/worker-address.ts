// The address a Playwright worker's requests claim to come from.
//
// The rate limiter counts by caller address (`clientIp` in server/utils/hash.ts:
// `cf-connecting-ip`, which only Cloudflare sets in production). Against the one
// local dev server every request would otherwise share `::1`, and with it one
// minute's allowance: 30 requests to /api/auth/ (server/middleware/auth.ts) and
// 20 dev sign-ins (server/api/auth/dev.post.ts). A full run of the suites spent
// all 30 inside a minute (measured 2026-11-18), so whether a run passed
// depended on where the minute fell, and a new spec that signed in could fail
// another layer's.
//
// So each worker is a caller of its own, as each browser would be in
// production. The limits are the real ones: a worker that makes 31 requests to
// /api/auth/ in a minute is still refused.

import { randomBytes } from 'node:crypto'

export const ADDRESS_HEADER = 'cf-connecting-ip'

// Per run as well as per worker: Playwright numbers workers from 0 every time,
// so two runs inside a minute would otherwise share addresses. The runner asks
// first (it imports playwright.config.ts) and the workers it starts inherit
// the answer.
const run = (process.env.E2E_RUN_ADDRESS ??= randomBytes(4).toString('hex'))

/**
 * `2001:db8:<run>::<worker>`, from the range kept for documentation. Read from
 * the environment, so it is the same wherever it is asked in a worker process:
 * playwright.config.ts (which every worker imports again) and a worker-scoped
 * fixture alike. A worker replaced after a failure has a new index. The runner
 * itself has none and gets `ffff`.
 */
export function workerAddress(): string {
  const index = process.env.TEST_WORKER_INDEX
  const worker = index === undefined ? 'ffff' : Number(index).toString(16)
  return `2001:db8:${run.slice(0, 4)}:${run.slice(4)}::${worker}`
}

/** For `extraHTTPHeaders`, on a browser context or a request context. */
export function workerAddressHeaders(): Record<string, string> {
  return { [ADDRESS_HEADER]: workerAddress() }
}
