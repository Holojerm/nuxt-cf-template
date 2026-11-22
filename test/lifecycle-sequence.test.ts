// The gate on server/utils/lifecycle-sequence.ts: the file a routine edits to
// change a lifecycle email. Whatever is written there has to be sound before it
// can merge, because the next thing that reads it is the daily send.

import { describe, expect, it } from 'vitest'

import { findUrgency } from '../shared/utils/announcements'
import {
  definitionProblems,
  emailLink,
  fillCopy,
  isImmediate,
  renderDefinition,
  type LifecycleStepDefinition,
} from '../server/utils/lifecycle-definitions'
import { ANNOUNCEMENTS_PER_WEEK, LIFECYCLE_SEQUENCE } from '../server/utils/lifecycle-sequence'
import {
  IMMEDIATE_LIFECYCLE_STEPS,
  TEMPLATE_LIFECYCLE_STEPS,
} from '../server/utils/lifecycle-steps'
import { stepKey } from '../server/utils/fleet-email'

const BRAND = { appName: 'My App', appUrl: 'https://my-app.example' }

const sample: LifecycleStepDefinition = {
  id: 'sample',
  notification: 'tips',
  since: 'signup',
  afterDays: 3,
  forDays: 4,
  subject: 'Hello from {{appName}}',
  heading: 'Hello',
  paragraphs: ['Hi {{name}}.'],
  button: { label: 'Open', path: '/dashboard' },
  footnote: 'Sent once.',
}

describe('the lifecycle sequence', () => {
  it.each(LIFECYCLE_SEQUENCE.map((definition) => [definition.id, definition] as const))(
    '%s is a sound definition',
    (_id, definition) => {
      expect(definitionProblems(definition)).toEqual([])
      // The id is what /api/fleet reports sends under.
      expect(stepKey(definition.id)).toBe(definition.id)
    },
  )

  it('has no two steps with one id', () => {
    const ids = LIFECYCLE_SEQUENCE.map((definition) => definition.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the ids already in the send ledger', () => {
    // A renamed id re-sends that email to every account. Add ids; never change one.
    const ids = LIFECYCLE_SEQUENCE.map((definition) => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['welcome', 'activation_nudge', 'win_back']))
  })

  it('never runs a step that is switched off', () => {
    // `enabled: false` is how a step is held back (the template ships `win_back`
    // that way). It must keep the step out of the daily run and out of sign-up.
    const off = LIFECYCLE_SEQUENCE.filter((definition) => definition.enabled === false)
    const running = [...TEMPLATE_LIFECYCLE_STEPS, ...IMMEDIATE_LIFECYCLE_STEPS].map(
      (step) => step.id,
    )
    for (const definition of off) expect(running).not.toContain(definition.id)
    expect(TEMPLATE_LIFECYCLE_STEPS).toHaveLength(LIFECYCLE_SEQUENCE.length - off.length)
  })

  it('sets a weekly announcement cap of at least one', () => {
    expect(Number.isInteger(ANNOUNCEMENTS_PER_WEEK)).toBe(true)
    expect(ANNOUNCEMENTS_PER_WEEK).toBeGreaterThanOrEqual(1)
  })
})

describe('definitionProblems', () => {
  it.each([
    ['a mandatory class', { notification: 'billing.receipt' as never }, 'switch off'],
    ['an unbounded window', { forDays: 0 }, 'bounded'],
    ['a negative delay', { afterDays: -1 }, 'afterDays'],
    ['an id that is not snake_case', { id: 'Win Back' }, 'snake_case'],
    ['an unknown tag', { paragraphs: ['Hi {{firstName}}'] }, '{{firstName}}'],
    ['urgency', { subject: 'Last chance to come back' }, 'urgency'],
    ['scarcity', { paragraphs: ['Only 3 spots left.'] }, 'urgency'],
    ['an off-site button', { button: { label: 'Go', path: 'https://evil.example' } }, 'path'],
    ['empty copy', { footnote: ' ' }, 'must all have text'],
  ])('refuses %s', (_name, change, expected) => {
    const problems = definitionProblems({ ...sample, ...change })
    expect(problems.join(' | ')).toContain(expected)
  })

  it('accepts the sample', () => {
    expect(definitionProblems(sample)).toEqual([])
  })
})

describe('rendering a definition', () => {
  it('fills the two tags and tags the link with the step', () => {
    const email = renderDefinition(sample, BRAND, { name: 'Ada' })
    expect(email.subject).toBe('Hello from My App')
    expect(email.text).toContain('Hi Ada.')
    expect(email.text).toContain(
      'Open: https://my-app.example/dashboard?utm_source=email&utm_medium=lifecycle&utm_campaign=sample',
    )
  })

  it('escapes a hostile display name, and never re-reads it as a tag', () => {
    const email = renderDefinition(sample, BRAND, { name: '<b>{{appName}}</b>' })
    expect(email.html).toContain('&lt;b&gt;{{appName}}&lt;/b&gt;')
    expect(email.html).not.toContain('<b>')
  })

  it('leaves text alone when there is nothing to fill', () => {
    expect(fillCopy('No tags here.', { appName: 'X', name: 'Y' })).toBe('No tags here.')
    expect(emailLink('https://a.example', '/p?x=1', 'lifecycle', 's')).toContain('/p?x=1&utm_')
  })

  it('treats a zero-day sign-up step as immediate, and nothing else', () => {
    expect(isImmediate({ ...sample, afterDays: 0 })).toBe(true)
    expect(isImmediate(sample)).toBe(false)
    expect(isImmediate({ ...sample, afterDays: 0, since: 'last_sign_in' })).toBe(false)
  })
})

describe('findUrgency', () => {
  it('lets plain copy through', () => {
    expect(findUrgency('Your account and everything in it are as you left them.')).toBeNull()
    expect(findUrgency('This is the only reminder we send about setup.')).toBeNull()
  })

  it.each(['Act now', 'Hurry!', "Don't miss out", 'A limited-time offer', 'Ends tonight'])(
    'catches "%s"',
    (text) => {
      expect(findUrgency(text)).not.toBeNull()
    },
  )
})
