// What an announcement is, and the copy rule every unasked-for email shares.
//
// An announcement is one markdown file in content/announcements/. The build
// (scripts/announcement-source.ts) parses and validates each file into the shape
// below; the Worker only ever sees the parsed list. In `shared/` because the
// build script, the tests and the Worker all read the same definitions.

/** Who an announcement goes to. Every audience is people who allow product mail. */
export const ANNOUNCEMENT_AUDIENCES = ['everyone', 'users', 'activated', 'subscribers'] as const

export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number]

export interface Announcement {
  /** The filename. Stored in `lifecycle_sends` as `announcement.<id>`: never rename one. */
  id: string
  subject: string
  heading: string
  /** `YYYY-MM-DD`, UTC. The send starts on or after this day, never before. */
  date: string
  audience: AnnouncementAudience
  paragraphs: string[]
  /** `path` is a path on this app (`/changelog`), never another origin. */
  button?: { label: string; path: string }
}

/** `announcement.` plus the id must fit the 40 characters /api/fleet keeps of a step id. */
export const ANNOUNCEMENT_ID = /^[a-z0-9][a-z0-9-]{0,26}$/

export const ANNOUNCEMENT_STEP_PREFIX = 'announcement.'

export const announcementStepId = (id: string): string => `${ANNOUNCEMENT_STEP_PREFIX}${id}`

/**
 * Phrases that manufacture pressure. The product rules forbid urgency and
 * scarcity in copy, and an email nobody asked for is where they usually start,
 * so the build refuses an announcement that uses one and a test refuses a
 * lifecycle step that does. A short list of the unambiguous ones, not a style
 * checker: a reviewer still reads the copy.
 */
const URGENCY = [
  /\blast chance\b/i,
  /\bact now\b/i,
  /\bhurry\b/i,
  /\bdon'?t miss\b/i,
  /\blimited[- ]time\b/i,
  /\bonly \d+ (left|remaining|spots?|seats?)\b/i,
  /\b(ends|expires) (today|tonight|soon|in \d+ (hours?|days?))\b/i,
  /\bbefore it'?s (gone|too late)\b/i,
  /\bwhile supplies last\b/i,
]

/** The first pressure phrase in `text`, or null. */
export function findUrgency(text: string): string | null {
  for (const pattern of URGENCY) {
    const match = text.match(pattern)
    if (match) return match[0]
  }
  return null
}
