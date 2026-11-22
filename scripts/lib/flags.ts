// PostHog feature-flag control for the growth routines. Logic only: scripts/flags.ts is
// the CLI around it, and test/flags.test.ts drives it with a mocked fetch.
//
// The guard that matters: every write refuses a key that does not start with `growth-`, so a
// routine can start and end its own experiments and cannot touch a product flag. There is
// deliberately no verb that edits targeting, variants or properties, and no hard delete.
//
// API: https://posthog.com/docs/api/feature-flags (OpenAPI at https://us.posthog.com/api/schema/).
// `archived` requires `active: false`; a flag is looked up by exact `?key=`.

export const PREFIX = 'growth-'
const KEY = /^growth-[a-z0-9][a-z0-9-]*$/
const PAGE = 100
const MAX_PAGES = 20

export interface Deps {
  fetch: typeof fetch
  apiKey: string
  projectId: string
  /** Origin of the PostHog app API, no trailing slash. */
  host: string
}

export class FlagError extends Error {}

interface Group {
  properties?: unknown[]
  rollout_percentage?: number | null
  [k: string]: unknown
}
interface Flag {
  id: number
  key: string
  active: boolean
  archived?: boolean
  filters?: { groups?: Group[]; [k: string]: unknown }
}
export interface FlagSummary {
  id: number
  key: string
  active: boolean
  archived: boolean
  /** Rollout of each release condition group, in order. */
  rollout: (number | null)[]
}

/**
 * The management API lives on the app host, not the ingestion host the browser SDK uses:
 * `https://us.i.posthog.com` → `https://us.posthog.com`.
 */
export function appHost(ingestHost = 'https://us.i.posthog.com'): string {
  const url = new URL(ingestHost)
  url.hostname = url.hostname.replace(/\.i\.posthog\.com$/, '.posthog.com')
  return url.origin
}

/** Reads credentials from the environment. Values are never echoed, even in errors. */
export function depsFromEnv(env: Record<string, string | undefined>, f = fetch): Deps {
  const missing = ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID'].filter((n) => !env[n])
  if (missing.length) throw new FlagError(`missing ${missing.join(', ')}`)
  const projectId = env.POSTHOG_PROJECT_ID!
  if (!/^\d+$/.test(projectId)) throw new FlagError('POSTHOG_PROJECT_ID must be numeric')
  return {
    fetch: f,
    apiKey: env.POSTHOG_PERSONAL_API_KEY!,
    projectId,
    host: appHost(env.NUXT_PUBLIC_POSTHOG_HOST || undefined),
  }
}

export function assertGrowthKey(key: string | undefined): asserts key is string {
  if (!key || !key.startsWith(PREFIX))
    throw new FlagError(`refusing "${key ?? ''}": growth flags only, keys start with "${PREFIX}"`)
  if (!KEY.test(key))
    throw new FlagError(`invalid key "${key}": use lowercase letters, digits, hyphens`)
}

export function assertPercent(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (raw === '' || !Number.isInteger(n) || n < 0 || n > 100)
    throw new FlagError(`rollout must be a whole number from 0 to 100, got "${raw}"`)
  return n
}

async function call<T>(d: Deps, method: string, path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('http') ? path : `${d.host}/api/projects/${d.projectId}${path}`
  if (new URL(url).origin !== d.host)
    throw new FlagError('refusing to follow a link off the PostHog host')
  const res = await d.fetch(url, {
    method,
    headers: { authorization: `Bearer ${d.apiKey}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new FlagError(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : null) as T
}

const summarize = (f: Flag): FlagSummary => ({
  id: f.id,
  key: f.key,
  active: f.active,
  archived: Boolean(f.archived),
  rollout: (f.filters?.groups ?? []).map((g) => g.rollout_percentage ?? null),
})

async function find(d: Deps, key: string): Promise<Flag> {
  const page = await call<{ results: Flag[] }>(
    d,
    'GET',
    `/feature_flags/?key=${encodeURIComponent(key)}`,
  )
  // `key` is a case-insensitive filter; the exact match is the one we mean.
  const flag = page.results.find((f) => f.key === key)
  if (!flag)
    throw new FlagError(`no flag "${key}" (archived flags are not found; create a new key)`)
  return flag
}

export async function listFlags(d: Deps): Promise<FlagSummary[]> {
  const out: Flag[] = []
  let next: string | null = `/feature_flags/?limit=${PAGE}&search=${PREFIX}`
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page: { results: Flag[]; next: string | null } = await call(d, 'GET', next)
    out.push(...page.results)
    next = page.next
  }
  return out.filter((f) => f.key.startsWith(PREFIX)).map(summarize)
}

/** Created active at 0%: nobody sees the arm until `rollout` raises it. */
export async function createFlag(d: Deps, key: string): Promise<FlagSummary> {
  assertGrowthKey(key)
  const flag = await call<Flag>(d, 'POST', '/feature_flags/', {
    key,
    name: `Growth experiment ${key}`,
    active: true,
    filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
  })
  return summarize(flag)
}

/** Sets every release-condition group to `percent`, keeping the rest of the flag's targeting. */
export async function setRollout(d: Deps, key: string, percent: number): Promise<FlagSummary> {
  assertGrowthKey(key)
  assertPercent(percent)
  const flag = await find(d, key)
  const groups = flag.filters?.groups?.length ? flag.filters.groups : [{ properties: [] }]
  const patched = await call<Flag>(d, 'PATCH', `/feature_flags/${flag.id}/`, {
    filters: {
      ...flag.filters,
      groups: groups.map((g) => ({ ...g, rollout_percentage: percent })),
    },
  })
  return summarize(patched)
}

/** Rollout to 0, then disable and archive: PostHog only archives a flag that is inactive. */
export async function retireFlag(d: Deps, key: string): Promise<FlagSummary> {
  assertGrowthKey(key)
  const { id } = await setRollout(d, key, 0)
  const patched = await call<Flag>(d, 'PATCH', `/feature_flags/${id}/`, {
    active: false,
    archived: true,
  })
  return summarize(patched)
}
