// Feedback capture rules, run against a real D1 inside workerd.
//
// The endpoint is public, so the two things worth pinning down are that the
// submission schema rejects junk before it reaches the table, and that the
// per-source rate limit actually counts the right window.

import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  FEEDBACK_RATE_LIMIT,
  feedbackSubmissionSchema,
  hashIp,
  isRateLimited,
  listFeedback,
  recordFeedback,
  updateFeedbackStatus,
} from '../server/utils/feedback'

const db = drizzle(env.DB, { schema })

const HOUR_MS = 60 * 60 * 1000

/** D1 timestamps are epoch SECONDS — rows written in the same second tie on
 *  `created_at`, so anything asserting order sets the timestamps explicitly. */
async function backdate(id: string, createdAt: Date) {
  await db.update(schema.feedback).set({ createdAt }).where(eq(schema.feedback.id, id))
}

beforeEach(async () => {
  await db.delete(schema.feedback)
})

describe('feedbackSubmissionSchema', () => {
  it('defaults kind and trims the message', () => {
    const parsed = feedbackSubmissionSchema.parse({ message: '  the export button 404s  ' })
    expect(parsed.kind).toBe('idea')
    expect(parsed.message).toBe('the export button 404s')
  })

  it('rejects empty, oversized, and mistyped submissions', () => {
    expect(() => feedbackSubmissionSchema.parse({ message: 'no' })).toThrow()
    expect(() => feedbackSubmissionSchema.parse({ message: 'x'.repeat(2001) })).toThrow()
    expect(() => feedbackSubmissionSchema.parse({ kind: 'rant', message: 'hello there' })).toThrow()
    expect(() =>
      feedbackSubmissionSchema.parse({ message: 'hello there', email: 'not-an-email' }),
    ).toThrow()
    expect(() => feedbackSubmissionSchema.parse({ message: 'hello there', rating: 9 })).toThrow()
  })

  it('accepts an anonymous submission with a reply-to address', () => {
    const parsed = feedbackSubmissionSchema.parse({
      kind: 'bug',
      message: 'checkout hangs on the second step',
      email: 'someone@example.com',
      rating: 2,
    })
    expect(parsed.email).toBe('someone@example.com')
    expect(parsed.rating).toBe(2)
  })
})

describe('recordFeedback', () => {
  it('stores a signed-out submission with no user id', async () => {
    const row = await recordFeedback(
      db,
      feedbackSubmissionSchema.parse({ kind: 'bug', message: 'the export button 404s' }),
      { ipHash: 'hash-a', userAgent: 'Mozilla/5.0' },
    )

    expect(row.userId).toBeNull()
    expect(row.status).toBe('new')
    expect(row.kind).toBe('bug')
    expect(row.issueUrl).toBeNull()
  })

  it('truncates a hostile user agent instead of storing it whole', async () => {
    const row = await recordFeedback(
      db,
      feedbackSubmissionSchema.parse({ message: 'looks great' }),
      { userAgent: 'U'.repeat(5000) },
    )
    expect(row.userAgent).toHaveLength(256)
  })
})

describe('isRateLimited', () => {
  async function submitFrom(ipHash: string, createdAt?: Date) {
    const row = await recordFeedback(
      db,
      feedbackSubmissionSchema.parse({ message: 'another note about the thing' }),
      { ipHash },
    )
    if (createdAt) {
      await backdate(row.id, createdAt)
    }
  }

  it('lets the first submissions through and blocks the one over budget', async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) {
      expect(await isRateLimited(db, 'hash-b')).toBe(false)
      await submitFrom('hash-b')
    }
    expect(await isRateLimited(db, 'hash-b')).toBe(true)
  })

  it('scopes the budget to one source', async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) await submitFrom('hash-c')
    expect(await isRateLimited(db, 'hash-c')).toBe(true)
    expect(await isRateLimited(db, 'hash-d')).toBe(false)
  })

  it('ignores submissions older than the window', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS)
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) await submitFrom('hash-e', old)
    expect(await isRateLimited(db, 'hash-e')).toBe(false)
  })

  it('never blocks when the source is unknown', async () => {
    expect(await isRateLimited(db, null)).toBe(false)
  })
})

describe('hashIp', () => {
  it('is stable, salted, and null for an unknown address', async () => {
    const a = await hashIp('203.0.113.7', 'salt-1')
    const b = await hashIp('203.0.113.7', 'salt-1')
    const c = await hashIp('203.0.113.7', 'salt-2')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toContain('203.0.113.7')
    expect(await hashIp(undefined, 'salt-1')).toBeNull()
  })
})

describe('triage', () => {
  it('lists newest first and filters by status', async () => {
    const first = await recordFeedback(
      db,
      feedbackSubmissionSchema.parse({ message: 'first note in the queue' }),
      {},
    )
    await backdate(first.id, new Date(Date.now() - HOUR_MS))

    const second = await recordFeedback(
      db,
      feedbackSubmissionSchema.parse({ kind: 'bug', message: 'second note in the queue' }),
      {},
    )

    const all = await listFeedback(db)
    expect(all.map((row) => row.id)).toContain(first.id)
    expect(all[0]?.id).toBe(second.id)

    await updateFeedbackStatus(db, first.id, {
      status: 'triaged',
      issueUrl: 'https://github.com/acme/app/issues/12',
    })

    const untriaged = await listFeedback(db, { status: 'new' })
    expect(untriaged.map((row) => row.id)).toEqual([second.id])

    const triaged = await listFeedback(db, { status: 'triaged' })
    expect(triaged[0]?.issueUrl).toBe('https://github.com/acme/app/issues/12')
  })

  it('returns null for an id that does not exist', async () => {
    expect(await updateFeedbackStatus(db, 'nope', { status: 'closed' })).toBeNull()
  })
})
