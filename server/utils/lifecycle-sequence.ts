// The lifecycle emails this product sends, as data. THIS is the file to edit to
// change a step's wording, its delay or who gets it, or to add a step. The app
// owns it (app-owned.json): a template sync never overwrites it.
//
// Each entry is one email, sent once per account:
//
//   since      the clock: `signup`, or `last_sign_in`
//   afterDays  send once this many days have passed on that clock (0 = at once)
//   forDays    stop trying this many days later, so a step never reaches back
//              over every account the app has ever had
//   when       optional: `activated` or `not_activated` (finished onboarding)
//   enabled    false switches a step off without deleting it. `win_back` ships
//              that way: delete its `enabled: false` line to start sending it
//
// Copy may use {{appName}} and {{name}}, nothing else. `button.path` is a path
// on this app. `footnote` says why the reader got the email.
//
// Rules the tests enforce (test/lifecycle-sequence.test.ts): never rename an id
// (it is the once-only key, so a rename re-sends to everyone); no urgency or
// scarcity wording; `notification` is a preference the reader can switch off.
// A step that needs its own query is code, in lifecycle-app-steps.ts.

import type { LifecycleStepDefinition } from './lifecycle-definitions'

/**
 * Announcement emails one person may get in any seven days
 * (server/utils/announcements.ts). A send over it is skipped and counted, never
 * held for later.
 */
export const ANNOUNCEMENTS_PER_WEEK = 1

export const LIFECYCLE_SEQUENCE: readonly LifecycleStepDefinition[] = [
  {
    id: 'welcome',
    notification: 'welcome',
    since: 'signup',
    afterDays: 0,
    forDays: 1,
    subject: 'Welcome to {{appName}}',
    heading: 'Welcome to {{appName}}',
    paragraphs: [
      'Hi {{name}} — your account is ready.',
      "You're signed in already. If you ever get locked out, sign in again the same way and you'll land back on this account.",
    ],
    button: { label: 'Open the app', path: '/' },
    footnote:
      "You're receiving this because an account was created with this email address at {{appName}}.",
  },
  {
    id: 'activation_nudge',
    notification: 'tips',
    since: 'signup',
    afterDays: 1,
    forDays: 6,
    when: 'not_activated',
    subject: 'Finish setting up {{appName}}',
    heading: 'Pick up where you left off',
    paragraphs: [
      "Hi {{name}} — you created a {{appName}} account but haven't finished getting set up.",
      "It takes a couple of minutes, and the checklist on your dashboard shows exactly what's left.",
      'If something got in the way, reply to this email — a person reads it.',
    ],
    button: { label: 'Finish setting up', path: '/dashboard' },
    footnote: 'This is the only reminder we send about setup.',
  },
  {
    id: 'win_back',
    // Off until the app decides to write to people who stopped coming: the first
    // run after it is switched on mails every account inside the window below.
    enabled: false,
    notification: 'tips',
    since: 'last_sign_in',
    afterDays: 45,
    forDays: 14,
    subject: 'Your {{appName}} account is still here',
    heading: "It's been a while",
    paragraphs: [
      "Hi {{name}} — you haven't signed in to {{appName}} for a few weeks. Your account and everything in it are as you left them.",
      'If something was missing or got in the way, reply to this email and tell us. A person reads it.',
    ],
    button: { label: 'Sign in', path: '/dashboard' },
    footnote: 'This is the only email we send about coming back.',
  },
]
