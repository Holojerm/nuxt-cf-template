// Buffer's GraphQL API, one mutation: createPost with mode shareNow. Buffer
// holds the connection to each network, so the app needs one Bearer key and
// no per-network OAuth. The outbox owns timing, so Buffer's queue is never
// used — the free plan caps it at 10 posts a channel.

import type { SocialService } from './social-text'

export const BUFFER_API_URL = 'https://api.buffer.com'

/** The `metadata` key Buffer files each service's thread under. */
const BUFFER_METADATA_KEY: Record<SocialService, string> = {
  x: 'twitter',
  bluesky: 'bluesky',
}

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}`

export interface SocialSend {
  service: SocialService
  channelId: string
  /** One entry is a single post; more is a thread, in order. */
  posts: string[]
}

/**
 * What a send means for the outbox:
 *   sent    — Buffer created the post.
 *   retry   — Buffer definitely created nothing (an answered error), so
 *             sending again cannot double-post.
 *   unknown — the request may or may not have landed (network error, 5xx,
 *             unreadable body). Never retried automatically.
 */
export type PublishResult =
  | { status: 'sent'; remoteId: string }
  | { status: 'retry'; error: string; rateLimited: boolean }
  | { status: 'unknown'; error: string }

export type SocialPublisher = (send: SocialSend) => Promise<PublishResult>

interface CreatePostResponse {
  data?: {
    createPost?: { __typename?: string; post?: { id?: string }; message?: string } | null
  } | null
  errors?: { message?: string; extensions?: { code?: string } }[]
}

export function createBufferPublisher(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SocialPublisher {
  return async ({ service, channelId, posts }) => {
    const [text = '', ...rest] = posts
    const input: Record<string, unknown> = {
      channelId,
      text,
      schedulingType: 'automatic',
      mode: 'shareNow',
    }
    if (rest.length) {
      input.metadata = {
        [BUFFER_METADATA_KEY[service]]: { thread: posts.map((t) => ({ text: t })) },
      }
    }

    let response: Response
    try {
      response = await fetchImpl(BUFFER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: CREATE_POST, variables: { input } }),
      })
    } catch (err) {
      return { status: 'unknown', error: `network: ${String(err)}` }
    }

    if (response.status === 429) {
      return { status: 'retry', error: 'buffer: rate limited (429)', rateLimited: true }
    }
    // A 5xx may have been raised after the post was created.
    if (response.status >= 500)
      return { status: 'unknown', error: `buffer: HTTP ${response.status}` }

    let json: CreatePostResponse
    try {
      json = (await response.json()) as CreatePostResponse
    } catch {
      return response.ok
        ? { status: 'unknown', error: `buffer: unreadable body (HTTP ${response.status})` }
        : { status: 'retry', error: `buffer: HTTP ${response.status}`, rateLimited: false }
    }

    const result = json.data?.createPost
    if (result?.post?.id) return { status: 'sent', remoteId: result.post.id }
    if (result?.message)
      return { status: 'retry', error: `buffer: ${result.message}`, rateLimited: false }

    const error = json.errors?.[0]
    if (error) {
      const rateLimited = error.extensions?.code === 'RATE_LIMIT_EXCEEDED'
      return { status: 'retry', error: `buffer: ${error.message ?? 'GraphQL error'}`, rateLimited }
    }
    // A 4xx with no GraphQL error is a request Buffer refused outright.
    if (!response.ok)
      return { status: 'retry', error: `buffer: HTTP ${response.status}`, rateLimited: false }
    return { status: 'unknown', error: 'buffer: response carried neither a post nor an error' }
  }
}
