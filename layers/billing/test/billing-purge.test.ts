// Billing's nightly sweep of applied Paddle event ids (`paddle_events`), run
// the way the purge task runs a contributor, against a real D1 inside workerd.
// The dedupe row has to outlive Paddle's retry schedule, so it has its own
// window (30 days), not the 24h grace the credential tables use. Core's token
// sweep is in test/purge.test.ts.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { clearExtensionsForTest, getPurgeContributors } from '~~/server/utils/extensions'
import { purgeExpiredTokens } from '~~/server/utils/purge'
import {
  PADDLE_EVENT_RETENTION_SECONDS,
  registerBillingExtensions,
} from '../server/utils/billing-extensions'

const db = drizzle(env.DB, { schema })

const NOW = Date.parse('2026-08-22T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Dead, but inside the grace window — must survive. */
const RECENTLY = new Date(NOW - 1 * HOUR)

beforeEach(async () => {
  await env.DB.exec('DELETE FROM paddle_events')
})

describe('billing purge contributor — applied Paddle event ids', () => {
  beforeEach(() => registerBillingExtensions())
  afterEach(() => clearExtensionsForTest())

  /** Billing's sweep, run the way the purge task runs a contributor. */
  async function sweepPaddleEvents(options: { now: number; limit?: number }) {
    const contributor = getPurgeContributors().find((c) => c.key === 'paddleEvents')
    expect(contributor).toBeDefined()
    return contributor!.run(db, options)
  }

  async function addEvent(eventId: string, receivedAt: Date): Promise<void> {
    await db
      .insert(schema.paddleEvents)
      .values({ eventId, eventType: 'subscription.updated', occurredAt: receivedAt, receivedAt })
  }

  it('keeps an event id for the whole retention window, not just the grace window', async () => {
    // Paddle retries for days; a row swept after 24h would let a late
    // redelivery re-apply. Inside retention it stays, past it it goes.
    await addEvent('evt-old', new Date(NOW - (PADDLE_EVENT_RETENTION_SECONDS + 60) * 1000))
    await addEvent('evt-week', new Date(NOW - 7 * DAY))
    await addEvent('evt-fresh', RECENTLY)

    const result = await sweepPaddleEvents({ now: NOW })

    expect(result).toEqual({ count: 1, truncated: false })
    // The token sweep itself no longer touches the table.
    expect(await purgeExpiredTokens(db, { now: NOW })).not.toHaveProperty('paddleEvents')
    const remaining = await db.select({ id: schema.paddleEvents.eventId }).from(schema.paddleEvents)
    expect(remaining.map((row) => row.id).sort()).toEqual(['evt-fresh', 'evt-week'])
  })
})
