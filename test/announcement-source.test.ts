// The build step that turns content/announcements/*.md into what the Worker
// sends. A file that fails here fails `bun run email:build`, and so the PR.

import { describe, expect, it } from 'vitest'

import { ANNOUNCEMENTS } from '../server/emails/announcements.generated'
import { stepKey } from '../server/utils/fleet-email'
import { announcementStepId } from '../shared/utils/announcements'
import { announcementModuleSource, parseAnnouncement } from '../scripts/announcement-source'

const file = (fields: string, body = 'First paragraph.\n\nSecond\nparagraph.') =>
  `---\n${fields}\n---\n\n${body}\n`

const FIELDS = 'subject: Exports are here\ndate: 2026-11-25'

describe('parseAnnouncement', () => {
  it('reads the fields and splits the body into paragraphs', () => {
    const parsed = parseAnnouncement(
      'exports',
      file(
        `${FIELDS}\naudience: activated\nbutton_label: "See what changed"\nbutton_path: /changelog`,
      ),
    )
    expect(parsed).toEqual({
      id: 'exports',
      subject: 'Exports are here',
      heading: 'Exports are here',
      date: '2026-11-25',
      audience: 'activated',
      paragraphs: ['First paragraph.', 'Second paragraph.'],
      button: { label: 'See what changed', path: '/changelog' },
    })
  })

  it('defaults to everyone who allows product mail, with no button', () => {
    const parsed = parseAnnouncement('exports', file(FIELDS))
    expect(parsed.audience).toBe('everyone')
    expect(parsed.button).toBeUndefined()
  })

  it.each([
    ['a missing subject', 'date: 2026-11-25', undefined, 'subject'],
    ['a missing date', 'subject: Hi', undefined, 'date'],
    ['an impossible date', 'subject: Hi\ndate: 2026-13-45', undefined, 'date'],
    ['an unknown audience', `${FIELDS}\naudience: all_users`, undefined, 'audience'],
    ['an unknown field', `${FIELDS}\nsend_to: everyone`, undefined, 'unknown field'],
    ['half a button', `${FIELDS}\nbutton_label: Go`, undefined, 'go together'],
    [
      'an off-site button',
      `${FIELDS}\nbutton_label: Go\nbutton_path: //x.example`,
      undefined,
      'path',
    ],
    ['an empty body', FIELDS, '  ', 'no body'],
    ['markdown in the body', FIELDS, 'See [the post](https://x.example).', 'plain paragraphs'],
    ['a template tag', FIELDS, 'Hi {{name}}.', 'no {{tags}}'],
    ['urgency', 'subject: Last chance to export\ndate: 2026-11-25', undefined, 'urgency'],
    ['scarcity in the body', FIELDS, 'Only 5 seats left.', 'urgency'],
  ])('refuses %s', (_name, fields, body, expected) => {
    expect(() => parseAnnouncement('exports', file(fields, body))).toThrow(expected)
  })

  it('refuses a file with no field block, and a filename that cannot be a step id', () => {
    expect(() => parseAnnouncement('exports', 'Just text.')).toThrow('---')
    expect(() => parseAnnouncement('Exports_2026', file(FIELDS))).toThrow('filename')
    expect(() => parseAnnouncement('a'.repeat(28), file(FIELDS))).toThrow('filename')
  })

  it('keeps the longest allowed id inside what /api/fleet reports', () => {
    const stepId = announcementStepId('a'.repeat(27))
    expect(stepKey(stepId)).toBe(stepId)
  })
})

describe('announcementModuleSource', () => {
  it('orders by date, then id, so a rebuild is stable', () => {
    const later = parseAnnouncement('b-later', file('subject: B\ndate: 2026-12-01'))
    const first = parseAnnouncement('z-first', file('subject: Z\ndate: 2026-11-01'))
    const source = announcementModuleSource([later, first])
    expect(source.indexOf('z-first')).toBeLessThan(source.indexOf('b-later'))
    expect(source).toContain('export const ANNOUNCEMENTS')
  })
})

describe('the announcements in this repo', () => {
  it('all have distinct ids', () => {
    const ids = ANNOUNCEMENTS.map((announcement) => announcement.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
