// The x-replies guards, driven through a mocked fetch. Nothing here touches X:
// a call to an endpoint the mock does not list throws.

import { describe, expect, it } from 'vitest'

import { emptyState, listItems, sendReply, type Deps, type State } from '../scripts/lib/x-replies'

const ME = { id: '1', username: 'product' }

function post(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    text: `@product hello ${id}`,
    author_id: `u${id}`,
    conversation_id: `c${id}`,
    entities: { mentions: [{ username: 'product' }] },
    ...over,
  }
}

function mock(mentions: unknown[], search: unknown[] = [], extra: Record<string, unknown> = {}) {
  const calls: { method: string; url: string; body?: string }[] = []
  const users = [...mentions, ...search].map((p) => ({
    id: (p as { author_id: string }).author_id,
    username: `user${(p as { id: string }).id}`,
    public_metrics: { followers_count: 12 },
  }))
  const fetchMock = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.includes('/users/me')) return json({ data: ME })
    if (url.includes('/mentions'))
      return json({ data: mentions, includes: { users, ...extra }, meta: { newest_id: '9' } })
    if (url.includes('/search/recent')) return json({ data: search, includes: { users } })
    if (url.endsWith('/2/tweets') && init?.method === 'POST') return json({ data: { id: '500' } })
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
  const deps: Deps = {
    fetch: fetchMock,
    creds: { consumerKey: 'k', consumerSecret: 's', token: 't', tokenSecret: 'ts' },
    nonce: () => 'n',
    now: () => 1_700_000_000,
  }
  return { deps, calls }
}

async function listed(
  mentions: unknown[],
  search: unknown[] = [],
  state = emptyState(),
  extra = {},
) {
  const { deps, calls } = mock(mentions, search, extra)
  const result = await listItems(deps, state, {})
  return { deps, calls, ...result }
}

describe('list', () => {
  it('returns mentions with author, conversation and the post answered, and advances the cursor', async () => {
    const reply = post('2', {
      in_reply_to_user_id: '1',
      referenced_tweets: [{ type: 'replied_to', id: '77' }],
    })
    const { output, state, calls } = await listed([post('3'), reply], [], emptyState(), {
      tweets: [{ id: '77', text: 'our post', author_id: '1' }],
    })
    expect(output.items.map((i) => i.id)).toEqual(['2', '3'])
    expect(output.items[0]).toMatchObject({
      author: 'user2',
      conversationId: 'c2',
      kind: 'reply',
      answers: { id: '77', text: 'our post', ownPost: true },
      replyable: true,
    })
    expect(state.cursor).toBe('9')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('sends the stored cursor as since_id', async () => {
    const { calls } = await listed([], [], { ...emptyState(), account: ME, cursor: '42' })
    expect(calls.some((c) => c.url.includes('since_id=42'))).toBe(true)
  })

  it('merges search results without duplicates and drops our own posts', async () => {
    const { output } = await listed([post('3')], [post('3'), post('4', { author_id: '1' })])
    expect(output.items.map((i) => i.id)).toEqual(['3'])
  })

  it('marks a reply without an @mention as not replyable', async () => {
    const bare = post('5', { entities: {}, in_reply_to_user_id: '1' })
    const { output, state } = await listed([bare])
    expect(output.items[0]).toMatchObject({ replyable: false, summoned: false })
    expect(state.eligible).toEqual({})
  })

  it('treats a quote of our post as summoning', async () => {
    const quote = post('6', { entities: {}, referenced_tweets: [{ type: 'quoted', id: '78' }] })
    const { output } = await listed([quote], [], emptyState(), {
      tweets: [{ id: '78', text: 'ours', author_id: '1' }],
    })
    expect(output.items[0]).toMatchObject({ kind: 'quote', summoned: true, replyable: true })
  })

  it('honours an opt-out and remembers the author', async () => {
    const { output, state } = await listed([
      post('7', { text: '@product please stop replying to me' }),
    ])
    expect(output.items[0]!.replyable).toBe(false)
    expect(state.optedOut).toEqual(['u7'])
  })

  it('does not continue a branch we already answered', async () => {
    const answered = post('8', { referenced_tweets: [{ type: 'replied_to', id: '500' }] })
    const state: State = { ...emptyState(), account: ME, sent: ['500'] }
    const { output } = await listed([answered], [], state)
    expect(output.items[0]!.replyable).toBe(false)
  })
})

describe('reply', () => {
  async function ready(mentions = [post('3')]) {
    const { deps, calls, state } = await listed(mentions)
    return { deps, calls, state }
  }

  it('posts one reply to the post id and records the branch', async () => {
    const { deps, calls, state } = await ready()
    const result = await sendReply(deps, state, { to: '3', text: 'Short answer.' })
    const write = calls.find((c) => c.method === 'POST')!
    expect(JSON.parse(write.body!)).toEqual({
      text: 'Short answer.',
      reply: { in_reply_to_tweet_id: '3' },
    })
    expect(result.url).toBe('https://x.com/product/status/500')
    expect(result.state.run.count).toBe(1)
    expect(result.state.replied['c3:u3']).toBe('500')
  })

  it('makes no write call on --dry-run', async () => {
    const { deps, calls, state } = await ready()
    const result = await sendReply(deps, state, { to: '3', text: 'Short answer.', dryRun: true })
    expect(result.preview).toContain('dry run')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('refuses an id that list did not mark replyable', async () => {
    const { deps, state } = await ready()
    await expect(sendReply(deps, state, { to: '999', text: 'hi' })).rejects.toThrow(
      /not a replyable item/,
    )
  })

  it('refuses a second reply to the same person in the same conversation', async () => {
    const { deps, state } = await ready([
      post('3'),
      post('4', { author_id: 'u3', conversation_id: 'c3' }),
    ])
    const first = await sendReply(deps, state, { to: '3', text: 'One.' })
    await expect(sendReply(deps, first.state, { to: '4', text: 'Two.' })).rejects.toThrow(
      /already replied/,
    )
  })

  it('enforces the per-run cap', async () => {
    const { deps, calls } = mock([post('3'), post('4')])
    const { state } = await listItems(deps, emptyState(), { cap: 1 })
    const first = await sendReply(deps, state, { to: '3', text: 'One.' })
    await expect(sendReply(deps, first.state, { to: '4', text: 'Two.' })).rejects.toThrow(
      /cap of 1/,
    )
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('refuses links, hashtags, other @mentions and long text', async () => {
    const { deps, state } = await ready()
    const send = (text: string) => sendReply(deps, state, { to: '3', text })
    await expect(send('see https://example.com')).rejects.toThrow(/no link/)
    await expect(send('nice #tag')).rejects.toThrow(/hashtags/)
    await expect(send('cc @someoneelse')).rejects.toThrow(/@mention/)
    await expect(send('x'.repeat(281))).rejects.toThrow(/limit/)
    await expect(send('  ')).rejects.toThrow(/empty/)
    await expect(
      sendReply(deps, state, { to: '3', text: 'see https://a.b', allowLink: true, dryRun: true }),
    ).resolves.toBeTruthy()
  })
})
