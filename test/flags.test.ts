// The growth-flag guards, driven through a mocked fetch. Nothing here touches PostHog: a call
// the mock does not list throws.

import { describe, expect, it } from 'vitest'

import {
  FlagError,
  appHost,
  createFlag,
  depsFromEnv,
  listFlags,
  retireFlag,
  setRollout,
  type Deps,
} from '../scripts/lib/flags'

const HOST = 'https://us.posthog.com'
const SECRET = 'phx_super_secret'

interface Call {
  method: string
  url: string
  body?: Record<string, any>
}

function flag(key: string, over: Record<string, unknown> = {}) {
  return {
    id: key.length,
    key,
    active: true,
    archived: false,
    filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
    ...over,
  }
}

/** Replies from `routes` keyed by "METHOD path-and-query" (relative to the project). */
function mock(routes: Record<string, (body?: any) => { status?: number; json: unknown }>) {
  const calls: Call[] = []
  const f = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, url, body })
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    const route = routes[`${method} ${url.replace(`${HOST}/api/projects/42`, '')}`]
    if (!route) throw new Error(`unmocked ${method} ${url}`)
    const { status = 200, json } = route(body)
    return new Response(JSON.stringify(json), { status })
  }) as typeof fetch
  const deps: Deps = { fetch: f, apiKey: SECRET, projectId: '42', host: HOST }
  return { deps, calls }
}

describe('prefix guard', () => {
  const none = mock({})
  it.each(['dark-mode', 'Growth-x', 'xgrowth-x', '', 'growth'])(
    'refuses writes to %j',
    async (key) => {
      await expect(createFlag(none.deps, key)).rejects.toThrow(FlagError)
      await expect(setRollout(none.deps, key, 10)).rejects.toThrow(/growth flags only/)
      await expect(retireFlag(none.deps, key)).rejects.toThrow(/growth flags only/)
      expect(none.calls).toEqual([])
    },
  )

  it('refuses a key that could escape the URL', async () => {
    await expect(createFlag(none.deps, 'growth-x/../y')).rejects.toThrow(/invalid key/)
    await expect(setRollout(none.deps, 'growth-x?a=b', 5)).rejects.toThrow(/invalid key/)
    expect(none.calls).toEqual([])
  })

  it('lists only growth flags, following pages on the same host', async () => {
    const { deps, calls } = mock({
      'GET /feature_flags/?limit=100&search=growth-': () => ({
        json: {
          results: [flag('growth-a'), flag('product-growth-b')],
          next: `${HOST}/api/projects/42/feature_flags/?limit=100&offset=100&search=growth-`,
        },
      }),
      'GET /feature_flags/?limit=100&offset=100&search=growth-': () => ({
        json: {
          results: [flag('growth-c', { filters: { groups: [{ rollout_percentage: 25 }] } })],
          next: null,
        },
      }),
    })
    const out = await listFlags(deps)
    expect(out.map((f) => f.key)).toEqual(['growth-a', 'growth-c'])
    expect(out[1].rollout).toEqual([25])
    expect(calls).toHaveLength(2)
  })

  it('will not follow a next link off the PostHog host', async () => {
    const { deps } = mock({
      'GET /feature_flags/?limit=100&search=growth-': () => ({
        json: { results: [], next: 'https://evil.example/steal' },
      }),
    })
    await expect(listFlags(deps)).rejects.toThrow(/off the PostHog host/)
  })
})

describe('create', () => {
  it('posts an active flag at 0% rollout', async () => {
    const { deps, calls } = mock({
      'POST /feature_flags/': (body) => ({ json: flag(body.key) }),
    })
    const out = await createFlag(deps, 'growth-new-hero')
    expect(calls[0].body).toEqual({
      key: 'growth-new-hero',
      name: 'Growth experiment growth-new-hero',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
    })
    expect(out).toMatchObject({ key: 'growth-new-hero', active: true, rollout: [0] })
  })
})

describe('rollout', () => {
  const existing = flag('growth-a', {
    filters: {
      groups: [
        { properties: [{ key: 'plan', value: 'free' }], rollout_percentage: 0 },
        { properties: [], rollout_percentage: 5 },
      ],
      payloads: {},
    },
  })

  it('patches every group, keeping the rest of the targeting', async () => {
    const { deps, calls } = mock({
      'GET /feature_flags/?key=growth-a': () => ({
        json: { results: [flag('growth-ab'), existing] },
      }),
      [`PATCH /feature_flags/${existing.id}/`]: (body) => ({ json: { ...existing, ...body } }),
    })
    const out = await setRollout(deps, 'growth-a', 20)
    expect(calls[1].body).toEqual({
      filters: {
        groups: [
          { properties: [{ key: 'plan', value: 'free' }], rollout_percentage: 20 },
          { properties: [], rollout_percentage: 20 },
        ],
        payloads: {},
      },
    })
    expect(out.rollout).toEqual([20, 20])
  })

  it.each(['-1', '101', '2.5', 'abc', 'NaN'])('rejects percent %s before any call', async (raw) => {
    const { deps, calls } = mock({})
    await expect(setRollout(deps, 'growth-a', Number(raw))).rejects.toThrow(/whole number/)
    expect(calls).toEqual([])
  })

  it('says so when the flag does not exist', async () => {
    const { deps } = mock({ 'GET /feature_flags/?key=growth-a': () => ({ json: { results: [] } }) })
    await expect(setRollout(deps, 'growth-a', 5)).rejects.toThrow(/no flag "growth-a"/)
  })
})

describe('retire', () => {
  it('zeroes the rollout, then disables and archives, in that order', async () => {
    const f = flag('growth-a', {
      filters: { groups: [{ properties: [], rollout_percentage: 50 }] },
    })
    const { deps, calls } = mock({
      'GET /feature_flags/?key=growth-a': () => ({ json: { results: [f] } }),
      [`PATCH /feature_flags/${f.id}/`]: (body) => ({ json: { ...f, ...body } }),
    })
    const out = await retireFlag(deps, 'growth-a')
    expect(calls.map((c) => `${c.method} ${c.url.replace(HOST, '')}`)).toEqual([
      'GET /api/projects/42/feature_flags/?key=growth-a',
      `PATCH /api/projects/42/feature_flags/${f.id}/`,
      `PATCH /api/projects/42/feature_flags/${f.id}/`,
    ])
    expect(calls[1].body!.filters.groups[0].rollout_percentage).toBe(0)
    expect(calls[2].body).toEqual({ active: false, archived: true })
    expect(out).toMatchObject({ active: false, archived: true })
  })

  it('does not archive when the rollout patch fails', async () => {
    const f = flag('growth-a')
    const { deps, calls } = mock({
      'GET /feature_flags/?key=growth-a': () => ({ json: { results: [f] } }),
      [`PATCH /feature_flags/${f.id}/`]: () => ({ status: 403, json: { detail: 'nope' } }),
    })
    await expect(retireFlag(deps, 'growth-a')).rejects.toThrow(/403/)
    expect(calls).toHaveLength(2)
  })
})

describe('failed responses and credentials', () => {
  it('surfaces the status and body without the API key', async () => {
    const { deps } = mock({
      'POST /feature_flags/': () => ({ status: 400, json: { detail: 'key already exists' } }),
    })
    const error = await createFlag(deps, 'growth-a').catch((e) => e)
    expect(error).toBeInstanceOf(FlagError)
    expect(error.message).toContain('400')
    expect(error.message).toContain('key already exists')
    expect(error.message).not.toContain(SECRET)
  })

  it('names missing variables, never their values', () => {
    expect(() => depsFromEnv({ POSTHOG_PROJECT_ID: '1' })).toThrow(
      'missing POSTHOG_PERSONAL_API_KEY',
    )
    expect(() => depsFromEnv({ POSTHOG_PERSONAL_API_KEY: SECRET })).toThrow(
      'missing POSTHOG_PROJECT_ID',
    )
    expect(() =>
      depsFromEnv({ POSTHOG_PERSONAL_API_KEY: SECRET, POSTHOG_PROJECT_ID: 'x/y' }),
    ).toThrow('numeric')
  })

  it('maps the ingestion host to the app host', () => {
    expect(appHost('https://us.i.posthog.com')).toBe('https://us.posthog.com')
    expect(appHost('https://eu.i.posthog.com/')).toBe('https://eu.posthog.com')
    expect(appHost()).toBe('https://us.posthog.com')
    expect(appHost('https://posthog.example.com')).toBe('https://posthog.example.com')
    const deps = depsFromEnv({ POSTHOG_PERSONAL_API_KEY: SECRET, POSTHOG_PROJECT_ID: '42' })
    expect(deps.host).toBe(HOST)
  })
})
