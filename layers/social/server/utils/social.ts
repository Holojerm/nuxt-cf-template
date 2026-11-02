// The social outbox: the app enqueues, the `social:post` task drains.
//
// The one promise this file keeps is "never post twice". Enqueueing is
// idempotent on (service, kind, ref), and a row is marked `sending` BEFORE the
// request, so a send whose outcome is unknown can never be retried into a
// duplicate — it waits for a human instead. A missed post costs little; a
// doubled one is public.
//
// Every function takes the Drizzle client explicitly so the workerd suite can
// drive it against a real D1 binding.

import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
import type { SocialPublisher } from './buffer'
import { fitsSocial, SOCIAL_SERVICES, type SocialService } from './social-text'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type SocialDb = ReturnType<typeof drizzle<typeof tables>>

export const SOCIAL_STATUSES = [
  'queued',
  'sending',
  'sent',
  'dry-run',
  'suppressed',
  'failed',
  'unknown',
] as const
export type SocialStatus = (typeof SOCIAL_STATUSES)[number]

/** Sends attempted per row before it is marked `failed`. */
export const SOCIAL_MAX_ATTEMPTS = 3

/** Rows one drain sends. A backlog drains over several ticks, not in a burst. */
export const SOCIAL_DRAIN_LIMIT = 3

export interface SocialBody {
  /** One entry is a single post; more is a thread, in order. */
  posts: string[]
}

/** The Buffer channel per service; a service with no channel is skipped. */
export type SocialChannels = Partial<Record<SocialService, string>>

export interface SocialConfig {
  apiKey: string
  channels: SocialChannels
  /** False is a dry run: due rows become `dry-run` and nothing is sent. */
  enabled: boolean
}

/** From `runtimeConfig.social` (layers/social/nuxt.config.ts); null when no key is set. */
export function readSocialConfig(config: {
  enabled?: string
  bufferApiKey?: string
  channelX?: string
  channelBluesky?: string
}): SocialConfig | null {
  if (!config.bufferApiKey) return null
  const channels: SocialChannels = {}
  if (config.channelX) channels.x = config.channelX
  if (config.channelBluesky) channels.bluesky = config.channelBluesky
  return { apiKey: config.bufferApiKey, channels, enabled: config.enabled === '1' }
}

export interface SocialEnqueue {
  kind: string
  ref: string
  /** Earliest send time; defaults to now. */
  notBefore?: Date
  /** The body for one service — composed per service because the limits differ. */
  compose: (service: SocialService) => SocialBody
}

/**
 * Queue one post on every service that has a channel. Re-enqueueing the same
 * (kind, ref) is a no-op, so a caller can offer everything on every tick.
 * Returns how many rows were new.
 */
export async function enqueueSocialPost(
  db: SocialDb,
  channels: SocialChannels,
  post: SocialEnqueue,
): Promise<number> {
  const services = SOCIAL_SERVICES.filter((s) => channels[s])
  if (!services.length) return 0
  const rows = services.map((service) => ({
    service,
    kind: post.kind,
    ref: post.ref,
    body: JSON.stringify(post.compose(service)),
    notBefore: post.notBefore ?? new Date(),
  }))
  const inserted = await db
    .insert(tables.socialPosts)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: tables.socialPosts.id })
  return inserted.length
}

export interface SocialDrainProblem {
  id: string
  service: string
  kind: string
  ref: string
  status: 'failed' | 'unknown'
  error: string
}

export interface SocialDrainResult {
  sent: number
  dryRun: number
  retried: number
  /** Rows that need a human: give up after retries, or might have posted. */
  problems: SocialDrainProblem[]
}

export interface SocialDrainOptions {
  config: SocialConfig
  publisher: SocialPublisher
  now?: Date
  limit?: number
}

/** Send what is due, oldest first. */
export async function drainSocialPosts(
  db: SocialDb,
  { config, publisher, now = new Date(), limit = SOCIAL_DRAIN_LIMIT }: SocialDrainOptions,
): Promise<SocialDrainResult> {
  const result: SocialDrainResult = { sent: 0, dryRun: 0, retried: 0, problems: [] }

  const due = await db
    .select()
    .from(tables.socialPosts)
    .where(and(eq(tables.socialPosts.status, 'queued'), lte(tables.socialPosts.notBefore, now)))
    .orderBy(asc(tables.socialPosts.notBefore))
    .limit(config.enabled ? limit : 100)

  if (!config.enabled) {
    // Recorded, never sent: turning sending on later must not flush a backlog.
    const ids = due.map((row) => row.id)
    if (ids.length) {
      await db
        .update(tables.socialPosts)
        .set({ status: 'dry-run' })
        .where(and(eq(tables.socialPosts.status, 'queued'), inArray(tables.socialPosts.id, ids)))
    }
    result.dryRun = ids.length
    return result
  }

  for (const row of due) {
    const service = row.service as SocialService
    const fail = async (status: 'failed' | 'unknown', error: string) => {
      await db
        .update(tables.socialPosts)
        .set({ status, error })
        .where(eq(tables.socialPosts.id, row.id))
      result.problems.push({
        id: row.id,
        service: row.service,
        kind: row.kind,
        ref: row.ref,
        status,
        error,
      })
    }

    const channelId = config.channels[service]
    const body = JSON.parse(row.body) as SocialBody
    if (!channelId) {
      await fail('failed', `no channel configured for ${row.service}`)
      continue
    }
    const tooLong = body.posts.find((text) => !fitsSocial(service, text))
    if (!body.posts.length || tooLong !== undefined) {
      await fail(
        'failed',
        body.posts.length ? `over the ${row.service} length limit` : 'empty body',
      )
      continue
    }

    // Claim the row. The status guard makes an overlapping drain skip it.
    const claimed = await db
      .update(tables.socialPosts)
      .set({ status: 'sending', attempts: row.attempts + 1 })
      .where(and(eq(tables.socialPosts.id, row.id), eq(tables.socialPosts.status, 'queued')))
      .returning({ id: tables.socialPosts.id })
    if (!claimed.length) continue

    const outcome = await publisher({ service, channelId, posts: body.posts })
    if (outcome.status === 'sent') {
      await db
        .update(tables.socialPosts)
        .set({ status: 'sent', remoteId: outcome.remoteId, sentAt: now, error: null })
        .where(eq(tables.socialPosts.id, row.id))
      result.sent++
    } else if (outcome.status === 'unknown') {
      await fail('unknown', outcome.error)
    } else if (row.attempts + 1 >= SOCIAL_MAX_ATTEMPTS) {
      await fail('failed', outcome.error)
    } else {
      await db
        .update(tables.socialPosts)
        .set({ status: 'queued', error: outcome.error })
        .where(eq(tables.socialPosts.id, row.id))
      result.retried++
      // The quota is account-wide; pressing on would only spend more of it.
      if (outcome.rateLimited) break
    }
  }
  return result
}
