// The /api/fleet funnel: cohort-based, first-party, and safe to store elsewhere.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import {
  campaignKey,
  collectFleetFunnel,
  FUNNEL_TOP_LANDINGS,
  landingKey,
  sourceKey,
} from '../server/utils/fleet-funnel'
import { parseAttribution } from '../shared/utils/attribution'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

interface Touch {
  signupLanding?: string | null
  signupCampaign?: string | null
}

function user(
  id: string,
  createdDaysAgo: number,
  signupSource: string | null = null,
  touch: Touch = {},
) {
  const at = daysAgo(createdDaysAgo)
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    createdAt: at,
    updatedAt: at,
    signupSource,
    signupLanding: touch.signupLanding ?? null,
    signupCampaign: touch.signupCampaign ?? null,
  }
}

// NOW is a Saturday; its week began Monday 2026-09-21.
const WEEK_STARTS = [
  '2026-08-03',
  '2026-08-10',
  '2026-08-17',
  '2026-08-24',
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
]
const weeks = (counts: Record<string, { signups: number; activated: number }> = {}) =>
  WEEK_STARTS.map((weekStart) => ({
    weekStart,
    signups: 0,
    activated: 0,
    paid: 0,
    ...counts[weekStart],
  }))

describe('collectFleetFunnel', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_log')
    await env.DB.exec('DELETE FROM users')
  })

  it('counts each step within the signup cohort only', async () => {
    await db
      .insert(schema.users)
      .values([
        user('a', 2, 'google'),
        user('b', 5, 'Google'),
        user('c', 10, null),
        user('old', 40, 'google'),
      ])
    const activation = { actorType: 'user', action: 'onboarding.activated', targetType: 'user' }
    await db.insert(schema.auditLog).values([
      { ...activation, actorUserId: 'a', targetId: 'a' },
      { ...activation, actorUserId: 'b', targetId: 'b' },
      // A duplicate row (the check-then-write race onboarding.ts accepts) counts once.
      { ...activation, actorUserId: 'b', targetId: 'b' },
      // Outside the cohort: activated, but signed up 40 days ago.
      { ...activation, actorUserId: 'old', targetId: 'old' },
    ])
    expect(await collectFleetFunnel(db, NOW)).toEqual({
      cohortDays: 28,
      signups: 3,
      activated: 2,
      // No funnel contributor registered here: billing counts `paid`
      // (layers/billing/test/billing-fleet.test.ts).
      paid: 0,
      sources: { google: 2, direct: 1 },
      landings: { unknown: 3 },
      campaigns: {},
      // `old` is outside the 28 days but inside the eight weeks.
      weeks: weeks({
        '2026-08-17': { signups: 1, activated: 1 },
        '2026-09-14': { signups: 1, activated: 0 },
        '2026-09-21': { signups: 2, activated: 2 },
      }),
    })
  })

  it('is zeros and empty groups on an empty database', async () => {
    expect(await collectFleetFunnel(db, NOW)).toEqual({
      cohortDays: 28,
      signups: 0,
      activated: 0,
      paid: 0,
      sources: {},
      landings: {},
      campaigns: {},
      weeks: weeks(),
    })
  })

  it('groups the cohort by landing page, with `unknown` for none recorded', async () => {
    await db
      .insert(schema.users)
      .values([
        user('a', 1, null, { signupLanding: '/pricing' }),
        user('b', 2, null, { signupLanding: '/pricing' }),
        user('c', 3, null, { signupLanding: '/blog/rate-limits' }),
        user('d', 4),
        user('junk', 5, null, { signupLanding: '/search?q=ada@example.com' }),
        user('old', 40, null, { signupLanding: '/pricing' }),
      ])
    expect((await collectFleetFunnel(db, NOW)).landings).toEqual({
      '/pricing': 2,
      '/blog/rate-limits': 1,
      unknown: 1,
      other: 1,
    })
  })

  it('caps the landing pages it reports', async () => {
    const rows = Array.from({ length: FUNNEL_TOP_LANDINGS + 3 }, (_, index) =>
      user(`u${index}`, 1, null, { signupLanding: `/page-${index}` }),
    )
    // Two statements: D1 allows 100 bound values in one.
    await db.insert(schema.users).values(rows.slice(0, 7))
    await db.insert(schema.users).values(rows.slice(7))
    const { landings } = await collectFleetFunnel(db, NOW)
    expect(Object.keys(landings)).toHaveLength(FUNNEL_TOP_LANDINGS)
  })

  it('groups by campaign, leaving out signups that had none', async () => {
    await db
      .insert(schema.users)
      .values([
        user('a', 1, 'newsletter', { signupCampaign: 'Launch' }),
        user('b', 2, 'newsletter', { signupCampaign: 'launch' }),
        user('c', 3, 'x', { signupCampaign: 'spring_sale' }),
        user('d', 4, 'x', { signupCampaign: 'not a slug' }),
        user('e', 5, 'google'),
        user('old', 40, 'newsletter', { signupCampaign: 'launch' }),
      ])
    expect((await collectFleetFunnel(db, NOW)).campaigns).toEqual({
      launch: 2,
      spring_sale: 1,
      other: 1,
    })
  })
})

describe('sourceKey', () => {
  it('passes short slugs and buckets everything else', () => {
    expect(sourceKey(null)).toBe('direct')
    expect(sourceKey('news.ycombinator.com')).toBe('news.ycombinator.com')
    expect(sourceKey('x')).toBe('x')
    expect(sourceKey('hello world')).toBe('other')
    expect(sourceKey('a'.repeat(41))).toBe('other')
  })
})

describe('campaignKey', () => {
  it('passes short slugs and buckets everything else', () => {
    expect(campaignKey('launch-2026')).toBe('launch-2026')
    expect(campaignKey('ada@example.com')).toBe('other')
    expect(campaignKey(null)).toBe('other')
  })
})

// The routines tag every link they publish (.claude/routines/_shared.md › Tagged links) and
// judge channel bets on these keys, so a tag in that shape must come back unchanged.
describe('a link tagged by a routine', () => {
  const tagged = [
    { source: 'x', medium: 'social', campaign: 'x-post' },
    { source: 'x', medium: 'social', campaign: 'cache-tradeoffs-page' },
    { source: 'email', medium: 'announcement', campaign: 'announcement.exports' },
    { source: 'alternativeto', medium: 'directory', campaign: 'a'.repeat(40) },
  ]

  it.each(tagged)('reports $source / $campaign under its own keys', (tag) => {
    const first = parseAttribution({
      url: `https://app.example/blog/post?utm_source=${tag.source}&utm_medium=${tag.medium}&utm_campaign=${tag.campaign}`,
      // What X and a mail client send; the explicit tag has to win over both.
      referrer: 'https://t.co/abc',
      origin: 'https://app.example',
    })
    expect(first.medium).toBe(tag.medium)
    expect(sourceKey(first.source ?? null)).toBe(tag.source)
    expect(campaignKey(first.campaign ?? null)).toBe(tag.campaign)
  })

  it('loses a tag outside the shape to "other"', () => {
    const first = parseAttribution({
      url: 'https://app.example/?utm_source=x&utm_medium=social&utm_campaign=Launch%20Week',
    })
    expect(campaignKey(first.campaign?.toLowerCase() ?? null)).toBe('other')
  })
})

describe('landingKey', () => {
  it('passes route shapes, names a missing one, and buckets the rest', () => {
    expect(landingKey(null)).toBe('unknown')
    expect(landingKey('/')).toBe('/')
    expect(landingKey('/invite/:id')).toBe('/invite/:id')
    expect(landingKey('/Blog')).toBe('other')
    expect(landingKey('/a?token=secret')).toBe('other')
    expect(landingKey(`/${'a'.repeat(120)}`)).toBe('other')
  })
})
