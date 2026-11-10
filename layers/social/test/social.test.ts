// The social outbox, run against a real D1 inside workerd.
//
// The guarantee worth pinning down is "never post twice": enqueueing is
// idempotent, and a send whose outcome is unknown is never retried.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { createBufferPublisher, type PublishResult, type SocialSend } from '../server/utils/buffer'
import {
  drainSocialPosts,
  enqueueSocialPost,
  readSocialConfig,
  SOCIAL_MAX_ATTEMPTS,
  type SocialConfig,
} from '../server/utils/social'
import { fitSocialText, socialLength } from '../server/utils/social-text'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-11-02T12:00:00.000Z')
const CHANNELS = { x: 'chan-x', bluesky: 'chan-bsky' }
const LIVE: SocialConfig = { apiKey: 'k', channels: CHANNELS }

function post(ref: string, notBefore = new Date(NOW.getTime() - 1000)) {
  return { kind: 'alert', ref, notBefore, compose: () => ({ posts: [`post ${ref}`] }) }
}

/** A publisher that answers from a script and records every send. */
function scripted(...answers: PublishResult[]) {
  const sends: SocialSend[] = []
  const publisher = async (send: SocialSend) => {
    sends.push(send)
    return answers.shift() ?? { status: 'sent' as const, remoteId: `r${sends.length}` }
  }
  return { sends, publisher }
}

async function statuses() {
  const rows = await db.select().from(schema.socialPosts)
  return rows.map((r) => `${r.service}:${r.status}`).sort()
}

beforeEach(async () => {
  await db.delete(schema.socialPosts)
})

describe('readSocialConfig', () => {
  it('is null without a key, and a key is enough to send', () => {
    expect(readSocialConfig({ channelX: 'c' })).toBeNull()
    expect(readSocialConfig({ bufferApiKey: 'k', channelX: 'c' })).toEqual({
      apiKey: 'k',
      channels: { x: 'c' },
    })
  })
})

describe('enqueueSocialPost', () => {
  it('queues one row per configured service, once', async () => {
    expect(await enqueueSocialPost(db, CHANNELS, post('a'))).toBe(2)
    expect(await enqueueSocialPost(db, CHANNELS, post('a'))).toBe(0)
    expect(await enqueueSocialPost(db, { x: 'chan-x' }, post('b'))).toBe(1)
    expect(await statuses()).toEqual(['bluesky:queued', 'x:queued', 'x:queued'])
  })

  it('does nothing with no channels', async () => {
    expect(await enqueueSocialPost(db, {}, post('a'))).toBe(0)
  })
})

describe('drainSocialPosts', () => {
  it('sends due rows and records the remote id', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('a'))
    const { sends, publisher } = scripted({ status: 'sent', remoteId: 'buf-1' })
    const out = await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(out).toMatchObject({ sent: 1, problems: [] })
    expect(sends).toEqual([{ service: 'x', channelId: 'chan-x', posts: ['post a'] }])
    const [row] = await db.select().from(schema.socialPosts)
    expect(row).toMatchObject({ status: 'sent', remoteId: 'buf-1', attempts: 1 })
  })

  it('holds rows until not_before', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('later', new Date(NOW.getTime() + 60_000)))
    const { sends, publisher } = scripted()
    await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(sends).toHaveLength(0)
    expect(await statuses()).toEqual(['x:queued'])
  })

  it('never retries an unknown outcome', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('a'))
    const { sends, publisher } = scripted({ status: 'unknown', error: 'network: reset' })
    const out = await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(out.problems).toMatchObject([{ status: 'unknown', ref: 'a' }])
    await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(sends).toHaveLength(1)
    expect(await statuses()).toEqual(['x:unknown'])
  })

  it('retries an answered error, then gives up', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('a'))
    const refused = { status: 'retry' as const, error: 'buffer: nope', rateLimited: false }
    const { sends, publisher } = scripted(refused, refused, refused)
    let out
    for (let i = 0; i < SOCIAL_MAX_ATTEMPTS; i++) {
      out = await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    }
    expect(sends).toHaveLength(SOCIAL_MAX_ATTEMPTS)
    expect(out?.problems).toMatchObject([{ status: 'failed', error: 'buffer: nope' }])
    expect(await statuses()).toEqual(['x:failed'])
  })

  it('stops the drain on a rate limit', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('a', new Date(NOW.getTime() - 2000)))
    await enqueueSocialPost(db, { x: 'chan-x' }, post('b'))
    const { sends, publisher } = scripted({ status: 'retry', error: '429', rateLimited: true })
    const out = await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(sends).toHaveLength(1)
    expect(out.retried).toBe(1)
    expect(await statuses()).toEqual(['x:queued', 'x:queued'])
  })

  it('refuses a body over the limit without sending', async () => {
    await enqueueSocialPost(
      db,
      { x: 'chan-x' },
      { ...post('a'), compose: () => ({ posts: ['x'.repeat(281)] }) },
    )
    const { sends, publisher } = scripted()
    const out = await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(sends).toHaveLength(0)
    expect(out.problems).toMatchObject([{ status: 'failed' }])
  })

  it('leaves a suppressed row alone', async () => {
    await enqueueSocialPost(db, { x: 'chan-x' }, post('a'))
    await db.update(schema.socialPosts).set({ status: 'suppressed' })
    const { sends, publisher } = scripted()
    await drainSocialPosts(db, { config: LIVE, publisher, now: NOW })
    expect(sends).toHaveLength(0)
  })
})

describe('social text', () => {
  it('weighs an X link as 23 and wide characters as 2', () => {
    expect(socialLength('x', 'see https://example.com/a/very/long/path/that/goes/on')).toBe(4 + 23)
    expect(socialLength('x', '漢字')).toBe(4)
    expect(socialLength('bluesky', '👩‍👩‍👧')).toBe(1)
  })

  it('cuts the head at a word and never the tail', () => {
    const url = 'https://example.com/alerts/abc'
    const text = fitSocialText('x', 'word '.repeat(80).trim(), url)
    expect(socialLength('x', text)).toBeLessThanOrEqual(280)
    expect(text.endsWith(`word… ${url}`)).toBe(true)
    expect(fitSocialText('x', 'short', url)).toBe(`short ${url}`)
  })
})

describe('createBufferPublisher', () => {
  const send: SocialSend = { service: 'bluesky', channelId: 'c', posts: ['one', 'two'] }

  function answering(status: number, body: unknown) {
    const requests: { body: string; auth: string | null }[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push({
        body: String(init?.body),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { requests, publisher: createBufferPublisher('key', fetchImpl) }
  }

  it('sends shareNow with the thread under the service key', async () => {
    const { requests, publisher } = answering(200, { data: { createPost: { post: { id: 'p1' } } } })
    expect(await publisher(send)).toEqual({ status: 'sent', remoteId: 'p1' })
    const { variables } = JSON.parse(requests[0]!.body)
    expect(requests[0]!.auth).toBe('Bearer key')
    expect(variables.input).toEqual({
      channelId: 'c',
      text: 'one',
      schedulingType: 'automatic',
      mode: 'shareNow',
      metadata: { bluesky: { thread: [{ text: 'one' }, { text: 'two' }] } },
    })
  })

  it('maps answers to retry and ambiguity to unknown', async () => {
    const cases: [number, unknown, string][] = [
      [200, { data: { createPost: { message: 'Channel not found' } } }, 'retry'],
      [
        200,
        { errors: [{ message: 'slow down', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] },
        'retry',
      ],
      [429, '', 'retry'],
      [401, { errors: [{ message: 'unauthorized' }] }, 'retry'],
      [502, '', 'unknown'],
      [200, 'not json', 'unknown'],
      [200, { data: { createPost: null } }, 'unknown'],
    ]
    for (const [status, body, expected] of cases) {
      const { publisher } = answering(status, body)
      expect((await publisher(send)).status, `${status} ${JSON.stringify(body)}`).toBe(expected)
    }
  })

  it('treats a thrown fetch as unknown', async () => {
    const publisher = createBufferPublisher('key', (async () => {
      throw new Error('reset')
    }) as unknown as typeof fetch)
    expect(await publisher(send)).toMatchObject({ status: 'unknown' })
  })
})
