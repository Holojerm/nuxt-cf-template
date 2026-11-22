// The announcement build's pure parts: one markdown file in, one validated
// announcement out, and the module the Worker imports. No filesystem, so
// test/announcement-source.test.ts runs it in workerd; scripts/lib/email-compile.ts
// does the reading and writing. A file that fails here fails `bun run email:build`,
// which is how CI gates an announcement before it can be sent.
//
//   ---
//   subject: Exports are here
//   date: 2026-11-25
//   audience: everyone
//   button_label: See what changed
//   button_path: /changelog
//   ---
//
//   Plain paragraphs, separated by blank lines.

import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_ID,
  findUrgency,
  type Announcement,
  type AnnouncementAudience,
} from '../shared/utils/announcements'

const KEYS = ['subject', 'heading', 'date', 'audience', 'button_label', 'button_path']
const SUBJECT_MAX = 90

function fail(id: string, problem: string): never {
  throw new Error(`content/announcements/${id}.md: ${problem}`)
}

function frontmatter(id: string, block: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!match) fail(id, `cannot read the line "${line}" (expected key: value)`)
    const [, key, raw] = match as unknown as [string, string, string]
    if (!KEYS.includes(key)) fail(id, `unknown field "${key}" (known: ${KEYS.join(', ')})`)
    if (key in fields) fail(id, `"${key}" is set twice`)
    fields[key] = raw.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return fields
}

export function parseAnnouncement(id: string, source: string): Announcement {
  if (!ANNOUNCEMENT_ID.test(id)) {
    fail(id, 'the filename must be lowercase letters, digits and hyphens, 27 characters at most')
  }
  const match = source.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) fail(id, 'must start with a --- block of fields, closed by ---')
  const fields = frontmatter(id, match[1]!)

  const subject = fields.subject ?? ''
  if (!subject) fail(id, 'needs a subject')
  if (subject.length > SUBJECT_MAX) fail(id, `subject is over ${SUBJECT_MAX} characters`)

  const date = fields.date ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    fail(id, 'needs date: YYYY-MM-DD, the day the send may start')
  }

  const audience = (fields.audience ?? 'everyone') as AnnouncementAudience
  if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) {
    fail(id, `audience must be one of ${ANNOUNCEMENT_AUDIENCES.join(', ')}`)
  }

  const paragraphs = match[2]!
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
  if (!paragraphs.length) fail(id, 'has no body')
  for (const paragraph of paragraphs) {
    // The body is plain text, escaped on the way out: markdown would arrive as symbols.
    if (/^#{1,6}\s/.test(paragraph) || /\]\(/.test(paragraph) || /^[-*]\s/.test(paragraph)) {
      fail(id, 'the body is plain paragraphs: no headings, lists or [links](…)')
    }
  }

  const label = fields.button_label
  const path = fields.button_path
  if (Boolean(label) !== Boolean(path)) fail(id, 'button_label and button_path go together')
  if (path && !/^\/(?!\/)/.test(path)) fail(id, 'button_path must be a path on this app (/…)')

  const heading = fields.heading || subject
  for (const text of [subject, heading, label ?? '', ...paragraphs]) {
    if (text.includes('{{')) fail(id, 'announcements take no {{tags}}')
    const urgency = findUrgency(text)
    if (urgency) fail(id, `urgency wording is not allowed: "${urgency}"`)
  }

  return {
    id,
    subject,
    heading,
    date,
    audience,
    paragraphs,
    ...(label && path ? { button: { label, path } } : {}),
  }
}

/** The generated module, sorted by date then id so a rebuild is byte-stable. */
export function announcementModuleSource(announcements: Announcement[]): string {
  const sorted = [...announcements].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )
  return `// GENERATED — edit content/announcements/*.md, then bun run email:build
// Compiled by scripts/lib/email-compile.ts and not committed: postinstall and
// \`bun run ci\` rebuild it. server/utils/announcements.ts sends what is in here.

import type { Announcement } from '../../shared/utils/announcements'

export const ANNOUNCEMENTS: readonly Announcement[] = ${JSON.stringify(sorted, null, 2)}
`
}
