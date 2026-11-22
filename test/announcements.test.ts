// Announcement email: sent once, only to people who allow it, inside the weekly cap.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Announcement } from '../shared/utils/announcements'
import * as schema from '../server/db/schema'
import { runAnnouncements, type AnnouncementDeps } from '../server/utils/announcements'
import type { SendEmailOptions, SendEmailResult } from '../server/utils/email'

const db = drizzle(env.DB, { schema })

const NOW = new Date('2026-09-26T04:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

const announcement = (id: string, overrides: Partial<Announcement> = {}): Announcement => ({
  id,
  subject: `Subject ${id}`,
  heading: `Heading ${id}`,
  date: '2026-09-25',
  audience: 'everyone',
  paragraphs: ['First paragraph.', 'Second paragraph.'],
  button: { label: 'See what changed', path: '/changelog' },
  ...overrides,
})

async function addUser(id: string, email = `${id}@example.com`, createdDaysAgo = 30) {
  const at = daysAgo(createdDaysAgo)
  await db.insert(schema.users).values({ id, email, name: id, createdAt: at, updatedAt: at })
}

async function addSubscriber(id: string, confirmed = true, email = `${id}@example.com`) {
  await db
    .insert(schema.emailSubscribers)
    .values({ id, email, confirmedAt: confirmed ? daysAgo(10) : null, createdAt: daysAgo(11) })
}

function fakeDeps(weeklyCap = 1, result: SendEmailResult = { sent: true, id: 'x' }) {
  const sent: SendEmailOptions[] = []
  const state = { result }
  const deps: AnnouncementDeps = {
    brand: { appName: 'My App', appUrl: 'https://my-app.example' },
    send: async (opts) => {
      if (state.result.sent) sent.push(opts)
      return state.result
    },
    unsubscribeUrl: async (userId, type) => `https://my-app.example/u?${userId}&${type}`,
    subscriberUnsubscribeUrl: async (id) => `https://my-app.example/s?${id}`,
    weeklyCap,
  }
  return { deps, sent, state }
}

const recipients = (sent: SendEmailOptions[]) => sent.map((mail) => mail.to).sort()

beforeEach(async () => {
  for (const table of [
    'lifecycle_sends',
    'subscriber_sends',
    'announcement_runs',
    'email_subscribers',
    'notification_preferences',
    'audit_log',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`)
  }
})

describe('runAnnouncements', () => {
  it('sends once to accounts and confirmed subscribers, and records every send', async () => {
    await addUser('a')
    await addUser('b')
    await addSubscriber('s1')
    const { deps, sent } = fakeDeps()
    const exports = announcement('exports')

    const first = await runAnnouncements(db, [exports], deps, NOW)
    const second = await runAnnouncements(db, [exports], deps, new Date(NOW.getTime() + DAY_MS))

    expect(first.exports).toMatchObject({ state: 'finished', sent: 3, capped: 0 })
    expect(second).toEqual({})
    expect(recipients(sent)).toEqual(['a@example.com', 'b@example.com', 's1@example.com'])
    expect(sent[0]?.subject).toBe('Subject exports')
    expect(sent[0]?.html).toContain('utm_campaign=announcement.exports')

    const ledger = await db.select().from(schema.lifecycleSends)
    expect(ledger.map((row) => row.stepId)).toEqual([
      'announcement.exports',
      'announcement.exports',
    ])
    expect(await db.select().from(schema.subscriberSends)).toHaveLength(1)
    const [run] = await db.select().from(schema.announcementRuns)
    expect(run).toMatchObject({ announcementId: 'exports', sent: 3, capped: 0 })
    expect(run?.finishedAt).toEqual(NOW)
  })

  it('gives each kind of reader their own unsubscribe link', async () => {
    await addUser('a')
    await addSubscriber('s1')
    const { deps, sent } = fakeDeps()
    await runAnnouncements(db, [announcement('exports')], deps, NOW)

    const byAddress = Object.fromEntries(sent.map((mail) => [mail.to, mail.unsubscribe]))
    expect(byAddress['a@example.com']).toEqual({
      eventType: 'product_updates',
      url: 'https://my-app.example/u?a&product_updates',
    })
    expect(byAddress['s1@example.com']?.url).toBe('https://my-app.example/s?s1')
  })

  it('skips anyone who switched product updates off, and a deleted account', async () => {
    await addUser('a')
    await addUser('optout')
    await addUser('gone', 'deleted-gone@deleted.invalid')
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: 'optout', eventType: 'product_updates', enabled: false })
    const { deps, sent } = fakeDeps()

    const reports = await runAnnouncements(db, [announcement('exports')], deps, NOW)
    expect(reports.exports).toMatchObject({ sent: 1, optedOut: 2 })
    expect(recipients(sent)).toEqual(['a@example.com'])
  })

  it('never mails an unconfirmed subscriber, or one whose address has an account', async () => {
    await addUser('a')
    await addSubscriber('pending', false)
    await addSubscriber('dup', true, 'a@example.com')
    const { deps, sent } = fakeDeps()

    await runAnnouncements(db, [announcement('exports')], deps, NOW)
    expect(recipients(sent)).toEqual(['a@example.com'])
    expect(await db.select().from(schema.subscriberSends)).toEqual([])
  })

  it('skips and counts a send over the weekly cap, and never sends it later', async () => {
    await addUser('a')
    await addSubscriber('s1')
    const { deps, sent } = fakeDeps(1)
    const first = announcement('first')
    const second = announcement('second')

    const reports = await runAnnouncements(db, [first, second], deps, NOW)
    expect(reports.first).toMatchObject({ state: 'finished', sent: 2, capped: 0 })
    expect(reports.second).toMatchObject({ state: 'finished', sent: 0, capped: 2 })

    // Eight days on the week has rolled over, but the skipped send is not owed.
    const later = new Date(NOW.getTime() + 8 * DAY_MS)
    expect(await runAnnouncements(db, [first, second], deps, later)).toEqual({})
    expect(sent.map((mail) => mail.subject)).toEqual(['Subject first', 'Subject first'])
    const runs = await db.select().from(schema.announcementRuns)
    expect(runs.find((run) => run.announcementId === 'second')?.capped).toBe(2)
  })

  it('lets a later announcement through once the week has passed', async () => {
    await addUser('a')
    const { deps, sent } = fakeDeps(1)
    await runAnnouncements(db, [announcement('first')], deps, NOW)

    const later = new Date(NOW.getTime() + 8 * DAY_MS)
    const next = announcement('next', { date: '2026-10-03' })
    const reports = await runAnnouncements(db, [next], deps, later)
    expect(reports.next).toMatchObject({ sent: 1, capped: 0 })
    expect(sent).toHaveLength(2)
  })

  it('honours a higher cap', async () => {
    await addUser('a')
    const { deps, sent } = fakeDeps(2)
    await runAnnouncements(db, [announcement('one'), announcement('two')], deps, NOW)
    await runAnnouncements(db, [announcement('three')], deps, NOW)
    expect(sent).toHaveLength(2)
  })

  it('waits for its date, and does not send one found more than a fortnight late', async () => {
    await addUser('a')
    const { deps, sent } = fakeDeps()
    const reports = await runAnnouncements(
      db,
      [
        announcement('future', { date: '2026-09-27' }),
        announcement('stale', { date: '2026-09-01' }),
      ],
      deps,
      NOW,
    )
    expect(reports.future?.state).toBe('scheduled')
    expect(reports.stale?.state).toBe('expired')
    expect(sent).toEqual([])
    // The stale one is closed for good; the future one has no run yet.
    const runs = await db.select().from(schema.announcementRuns)
    expect(runs.map((run) => run.announcementId)).toEqual(['stale'])
  })

  it('leaves out anyone who arrived after the run started', async () => {
    await addUser('a')
    const { deps, sent, state } = fakeDeps()
    state.result = { sent: false, reason: 'error' }
    await runAnnouncements(db, [announcement('exports')], deps, NOW)

    await db.insert(schema.users).values({ id: 'late', email: 'late@example.com', name: 'late' })
    state.result = { sent: true, id: 'x' }
    await runAnnouncements(db, [announcement('exports')], deps, new Date(NOW.getTime() + DAY_MS))
    expect(recipients(sent)).toEqual(['a@example.com'])
  })

  it('stops where a send fails and resumes there, without double-sending', async () => {
    await addUser('a')
    await addUser('b')
    const { deps, sent, state } = fakeDeps()
    state.result = { sent: false, reason: 'error' }

    const down = await runAnnouncements(db, [announcement('exports')], deps, NOW)
    expect(down.exports).toMatchObject({ state: 'running', sent: 0 })
    expect(await db.select().from(schema.lifecycleSends)).toEqual([])

    state.result = { sent: true, id: 'x' }
    const up = await runAnnouncements(db, [announcement('exports')], deps, NOW)
    expect(up.exports).toMatchObject({ state: 'finished', sent: 2 })
    expect(recipients(sent)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('narrows to activated accounts, or to subscribers only', async () => {
    await addUser('a')
    await addUser('active')
    await addSubscriber('s1')
    await db.insert(schema.auditLog).values({
      actorUserId: 'active',
      actorType: 'user',
      action: 'onboarding.activated',
      targetType: 'user',
      targetId: 'active',
    })
    const { deps, sent } = fakeDeps(5)

    await runAnnouncements(db, [announcement('act', { audience: 'activated' })], deps, NOW)
    expect(recipients(sent)).toEqual(['active@example.com'])

    await runAnnouncements(db, [announcement('subs', { audience: 'subscribers' })], deps, NOW)
    expect(recipients(sent)).toEqual(['active@example.com', 's1@example.com'])
  })
})
