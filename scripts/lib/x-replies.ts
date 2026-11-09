// Read mentions of the product's X account and post replies to the people who
// addressed it. Logic only: scripts/x-replies.ts is the CLI around it, and
// test/x-replies.test.ts drives it with a mocked fetch.
//
// Every guard here exists because X's rules or this repo's routine rules say so
// (.claude/routines/x-replies.md): a reply must answer a post that summoned the
// account, once per person per conversation, up to a per-run cap, with no link
// and no third-party @mention. There is deliberately no like, follow, repost,
// quote or DM verb.

import { oauth1Header, percentEncode, type OAuth1Credentials } from './oauth1'

const API = 'https://api.x.com/2'
export const MAX_LENGTH = 280
export const DEFAULT_CAP = 3

export interface Deps {
  fetch: typeof fetch
  creds: OAuth1Credentials
  nonce: () => string
  now: () => number
}

export interface Item {
  id: string
  authorId: string
  author: string
  text: string
  conversationId: string
  kind: 'reply' | 'quote' | 'mention'
  /** The post this one answers: `ownPost` is true when it is one of the account's. */
  answers: { id: string; text?: string; ownPost: boolean } | null
  /** X only lets an API reply answer a post that @mentions or quotes the account. */
  summoned: boolean
  replyable: boolean
  reason?: string
  authorSignals: { followers?: number; createdAt?: string; verified?: boolean; bio?: string }
  url: string
}

export interface State {
  account?: { id: string; username: string }
  /** Newest post id already listed; the next `list` asks for anything newer. */
  cursor?: string
  eligible: Record<string, Item>
  /** `<conversation>:<author>` → id of our reply. */
  replied: Record<string, string>
  /** Ids of replies this account sent, to refuse continuing a branch we already answered. */
  sent: string[]
  optedOut: string[]
  run: { cap: number; count: number; listedAt?: string }
}

export const emptyState = (): State => ({
  eligible: {},
  replied: {},
  sent: [],
  optedOut: [],
  run: { cap: DEFAULT_CAP, count: 0 },
})

/** Phrases that mean "stop contacting me"; X's guidelines require honouring them at once. */
const OPT_OUT =
  /\b(stop (replying|messaging|mentioning|tagging)|unsubscribe|leave me alone|don'?t (reply|message|mention|tag) (to )?me|no more (replies|messages))\b/i

interface ApiPost {
  id: string
  text: string
  author_id?: string
  conversation_id?: string
  in_reply_to_user_id?: string
  referenced_tweets?: { type: string; id: string }[]
  entities?: { mentions?: { username: string }[] }
}
interface ApiUser {
  id: string
  username: string
  verified?: boolean
  created_at?: string
  description?: string
  public_metrics?: { followers_count?: number }
}
interface ApiPage {
  data?: ApiPost[]
  includes?: { tweets?: ApiPost[]; users?: ApiUser[] }
  meta?: { newest_id?: string; next_token?: string }
}

async function get<T>(deps: Deps, path: string, params: Record<string, string>): Promise<T> {
  const url = `${API}${path}`
  const authorization = await oauth1Header(deps.creds, {
    method: 'GET',
    url,
    params,
    nonce: deps.nonce(),
    timestamp: deps.now(),
  })
  const query = Object.entries(params)
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join('&')
  const res = await deps.fetch(`${url}?${query}`, { headers: { authorization } })
  const json = (await res.json().catch(() => null)) as unknown
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json as T
}

const FIELDS = {
  'tweet.fields':
    'author_id,conversation_id,created_at,entities,in_reply_to_user_id,referenced_tweets',
  expansions: 'author_id,referenced_tweets.id',
  'user.fields': 'created_at,description,public_metrics,verified',
  max_results: '100',
}

async function readAll(
  deps: Deps,
  path: string,
  extra: Record<string, string>,
  cap = 3,
): Promise<ApiPage[]> {
  const pages: ApiPage[] = []
  let token: string | undefined
  for (let i = 0; i < cap; i++) {
    const params = { ...FIELDS, ...extra, ...(token ? { pagination_token: token } : {}) }
    const page = await get<ApiPage>(deps, path, params)
    pages.push(page)
    token = page.meta?.next_token
    if (!token) break
  }
  return pages
}

const newer = (a: string, b: string) => (a.length === b.length ? a > b : a.length > b.length)

export async function listItems(
  deps: Deps,
  state: State,
  opts: { cap?: number; since?: string } = {},
): Promise<{
  state: State
  output: { account: string; cursor?: string; remaining: number; items: Item[] }
}> {
  const next: State = structuredClone(state)
  if (!next.account) {
    const me = await get<{ data: { id: string; username: string } }>(deps, '/users/me', {})
    next.account = { id: me.data.id, username: me.data.username }
  }
  const account = next.account
  const since = opts.since ?? next.cursor
  const sinceParam = since ? { since_id: since } : {}

  // Mentions cover replies that carry the @handle; `to:` search catches replies that
  // answer one of our posts. Both are deduplicated by post id.
  const pages = [
    ...(await readAll(deps, `/users/${account.id}/mentions`, sinceParam)),
    ...(await readAll(deps, '/tweets/search/recent', {
      query: `to:${account.username}`,
      ...sinceParam,
    })),
  ]
  const posts = new Map<string, ApiPost>()
  const referenced = new Map<string, ApiPost>()
  const users = new Map<string, ApiUser>()
  let newest = since
  for (const page of pages) {
    for (const post of page.data ?? []) posts.set(post.id, post)
    for (const post of page.includes?.tweets ?? []) referenced.set(post.id, post)
    for (const user of page.includes?.users ?? []) users.set(user.id, user)
    const id = page.meta?.newest_id
    if (id && (!newest || newer(id, newest))) newest = id
  }

  const items: Item[] = []
  for (const post of [...posts.values()].sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) {
    if (post.author_id === account.id) continue
    const author = users.get(post.author_id ?? '')
    const refs = post.referenced_tweets ?? []
    const repliedTo = refs.find((r) => r.type === 'replied_to')
    const quoted = refs.find((r) => r.type === 'quoted')
    const target = repliedTo ?? quoted
    const targetPost = target ? (referenced.get(target.id) ?? posts.get(target.id)) : undefined
    const quotesOurs = !!quoted && referenced.get(quoted.id)?.author_id === account.id
    const mentionsUs = !!post.entities?.mentions?.some(
      (m) => m.username.toLowerCase() === account.username.toLowerCase(),
    )
    const kind: Item['kind'] = quotesOurs
      ? 'quote'
      : post.in_reply_to_user_id === account.id
        ? 'reply'
        : 'mention'
    const summoned = mentionsUs || quotesOurs

    let reason: string | undefined
    if (!summoned) reason = 'does not @mention or quote the account; X rejects an API reply'
    else if (next.optedOut.includes(post.author_id ?? '')) reason = 'author asked us to stop'
    else if (OPT_OUT.test(post.text)) {
      reason = 'author asked us to stop'
      if (post.author_id) next.optedOut.push(post.author_id)
    } else if (repliedTo && next.sent.includes(repliedTo.id))
      reason = 'answers one of our replies; the branch is already answered'
    else if (next.replied[`${post.conversation_id}:${post.author_id}`])
      reason = 'already replied to this person in this conversation'

    items.push({
      id: post.id,
      authorId: post.author_id ?? '',
      author: author?.username ?? '',
      text: post.text,
      conversationId: post.conversation_id ?? post.id,
      kind,
      answers: target
        ? { id: target.id, text: targetPost?.text, ownPost: targetPost?.author_id === account.id }
        : null,
      summoned,
      replyable: !reason,
      reason,
      authorSignals: {
        followers: author?.public_metrics?.followers_count,
        createdAt: author?.created_at,
        verified: author?.verified,
        bio: author?.description,
      },
      url: `https://x.com/${author?.username ?? 'i'}/status/${post.id}`,
    })
  }

  next.eligible = Object.fromEntries(items.filter((i) => i.replyable).map((i) => [i.id, i]))
  next.run = {
    cap: opts.cap ?? DEFAULT_CAP,
    count: 0,
    listedAt: new Date(deps.now() * 1000).toISOString(),
  }
  next.cursor = newest
  return {
    state: next,
    output: { account: account.username, cursor: newest, remaining: next.run.cap, items },
  }
}

export async function sendReply(
  deps: Deps,
  state: State,
  opts: { to: string; text: string; allowLink?: boolean; dryRun?: boolean },
): Promise<{ state: State; url?: string; preview: string }> {
  const { to } = opts
  const text = opts.text.trim()
  const item = state.eligible[to]
  if (!state.account) throw new Error('no state: run `list` first')
  if (!item)
    throw new Error(
      `${to} is not a replyable item from the last \`list\` (not a reply to, quote of, or mention of the account, or already handled)`,
    )
  if (state.run.count >= state.run.cap)
    throw new Error(`per-run cap of ${state.run.cap} replies reached`)
  const branch = `${item.conversationId}:${item.authorId}`
  if (state.replied[branch]) throw new Error('already replied to this person in this conversation')
  if (!text) throw new Error('the reply is empty')
  if (text.length > MAX_LENGTH)
    throw new Error(`the reply is ${text.length} characters; the limit is ${MAX_LENGTH}`)
  if (!opts.allowLink && /https?:\/\/|\bwww\./i.test(text))
    throw new Error('replies carry no link unless --allow-link (a post with a URL costs far more)')
  if (/(^|\s)#\w/.test(text)) throw new Error('replies carry no hashtags')
  const others = [...text.matchAll(/@(\w+)/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((name) => name !== item.author.toLowerCase())
  if (others.length)
    throw new Error(
      `replies do not @mention anyone but the person addressed (${others.join(', ')})`,
    )

  const preview = `reply to ${item.url} (${text.length} characters):\n${text}`
  if (opts.dryRun) return { state, preview: `dry run: would ${preview}` }

  const url = `${API}/tweets`
  const authorization = await oauth1Header(deps.creds, {
    method: 'POST',
    url,
    nonce: deps.nonce(),
    timestamp: deps.now(),
  })
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: to } }),
  })
  const json = (await res.json().catch(() => null)) as { data?: { id?: string } } | null
  if (!res.ok) throw new Error(`POST /tweets → ${res.status} ${JSON.stringify(json)}`)
  const id = json?.data?.id
  if (!id) throw new Error(`posted, but the response had no id: ${JSON.stringify(json)}`)

  const next: State = structuredClone(state)
  next.replied[branch] = id
  next.sent.push(id)
  delete next.eligible[to]
  next.run.count += 1
  return { state: next, url: `https://x.com/${state.account.username}/status/${id}`, preview }
}
