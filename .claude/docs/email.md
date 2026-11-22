# Transactional email

How an email is written (Maizzle templates, compiled at build time, filled in with Mustache), Resend over fetch, the `EMAIL_QUEUE` enqueue path, retry and dead-letter semantics, and why billing mail is decided on status transitions rather than on webhook events. Five rules here each cost real, undelivered mail when they were broken.

> **Load this when:** touching `emails/`, `server/utils/email*.ts`, `server/plugins/email-queue-consumer.ts`, notification preferences, or adding any new outbound email.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Writing an email

Markup lives in [`emails/`](../../emails), written in [Maizzle 6](https://maizzle.com/docs)
(Vue single-file templates, Tailwind 4). **Maizzle runs at build time only** — it needs Node, Vite
and a CSS toolchain, so it is a devDependency and nothing from it reaches the Worker.
`bun run email:build` compiles every template to `server/emails/generated.ts`, a gitignored
module of `{ [name]: { html, text } }` strings that still contain `{{mustache}}` tags.
At send time `renderEmail(name, data)` in
[`server/utils/render-email.ts`](../../server/utils/render-email.ts) fills them in.

```
emails/
  templates/purchase.vue    the HTML — content only
  templates/purchase.txt    the plain-text alternative, same tags
  components/Email*.vue     the chrome: EmailLayout, EmailParagraph, EmailButton
  samples.ts                sample data per template — previews and tests
  theme.generated.css       GENERATED from DESIGN.md — see Branding
  maizzle.config.ts
server/emails/generated.ts  GENERATED at install — never commit it
```

**To add an email:**

1. `emails/templates/<name>.vue` — wrap content in `<EmailLayout heading="…">`; paragraphs in
   `<EmailParagraph>`, a call to action in `<EmailButton href="{{appUrl}}/…">`, small print in
   `<template #footnote>`. Every `{{tag}}` in the body goes inside `<Raw>…</Raw>` (see below).
2. `emails/templates/<name>.txt` — the plain-text part, same tags, written by hand. Links read
   `Label: url`; the file ends with `{{appUrl}}`.
3. `emails/samples.ts` — an entry named `<name>` with realistic data.
4. `bun run email:build`, then `bun run email:dev` and look at it.
5. A function that returns `{ subject, html, text }` by calling
   `composeEmail('<name>', subject, brand, data)` (`server/utils/email-templates.ts`) —
   the subject, and turning a `Date` or an enum into the strings the template reads, stay in
   TypeScript. Add its action URL to `ACTION_URL` in `test/emails.test.ts`, plus a test for
   anything specific to it. `test/emails.test.ts` already proves it renders, leaves no `{{`
   behind, escapes hostile data, and that the text carries the action URL.

`postinstall` and `bun run ci` both run `email:build`, so the module is always rebuilt from the
templates on the machine that builds the Worker — there is no committed copy to go stale (one
used to fail every Maizzle or Tailwind Dependabot bump). The build fails when:
a `.vue` has no `.txt` (or the reverse); the HTML and the text read different fields (a field
only the HTML needs — a tone flag, a link target — is declared in the `.txt` as
`{{! html-only: a, b }}`); or Vue warned while rendering.

### Mustache rules

- **`{{name}}` escapes, `{{{name}}}` does not.** Mustache never sees an untrusted *template* —
  they are ours, compiled in CI. It only sees untrusted *data* (an OAuth display name, a feedback
  message, an error string), and the escaping is what makes that safe. `renderEmail` escapes
  only `& < > " '` — Mustache's stock escape also encodes `/` and `=`, which mangles every href.
- **Triple braces only for markup this code built itself**, never a value that began outside
  it, and each use needs a comment naming where the value comes from. There are none today.
- **Text renders with escaping off** — there is no markup to break out of, and `&amp;` in a
  plain-text inbox is a bug.
- **Wrap every tag in `<Raw>` in templates** — `Hi <Raw>{{name}}</Raw>` — or Vue evaluates it and
  renders it blank (the build fails on the warning). Tags inside an *attribute*
  (`href="{{url}}"`, `heading="…"`) are literal strings and need no wrapper. Always write
  `<Raw>…</Raw>`, never self-closed `<Raw :content="x" />`: Maizzle's pass matches up to the
  next `</Raw>` and a self-closed one swallows the rest of the file.
- **Sections** are `{{#list}}…{{/list}}` (loop, or "if truthy") and `{{^x}}…{{/x}}` ("if not").
  A value is truthy when it is non-empty and not `0`/`null`/`false`. A color that depends on
  runtime data cannot be inlined at build time, so the template carries one copy per choice —
  see `emails/templates/access-ended.vue`.
- **Don't hand-format `emails/**/*.vue`** — it is excluded from `oxfmt`, which splits
  `</Raw>` across lines and breaks Maizzle's extraction.

### Plain text

Each email has a hand-written `.txt`, not Maizzle's `plaintext` feature. Its output is derived
from the HTML after CSS inlining and merges adjacent paragraphs onto one line, renders links as
`label\n\nurl`, and — the deciding case — turns a `{{#rows}}` loop into one run-on line, because
section tags are text to it and not the standalone lines Mustache needs to remove them. A `.txt`
is the format list bullets need, and it is the one thing a
reviewer can read without compiling anything.

### Branding

Email clients support neither CSS variables nor `oklch`, so the email's Tailwind theme is
**generated** from DESIGN.md, not hand-written: `bun run brand:generate` resolves the `email-*`
roles in DESIGN.md › Brand mark › Color roles to hex (using the Chromium it already drives for
the icons) and writes `emails/theme.generated.css` (colors and font stacks) and
`public/email-logo.png` (cut from `Logo.vue` — PNG because Gmail drops SVG). `brand:check`
fingerprints the inputs. Emails reference the logo as `{{appUrl}}/email-logo.png`, `alt` = the
app name. **A fork that rebrands runs `bun run brand:generate` then `bun run email:build`** and
gets on-brand email with no template change; `design:check` scans `app/` only, so hex in emails is
fine. Colors come from the theme (`text-ink`, `bg-accent`, `border-rule`); never type a hex.

### Preview

- `bun run email:dev` — Maizzle's dev server (it prints its URL). Lists every template, filled
  from `emails/samples.ts`, live-reloading as you edit.
- `bun run email:preview [dir]` — writes every email as the Worker would send it (compiled
  module + Mustache, HTML and text) to `dir` (default `.email-preview/`).

---

### In a repo with bun workspaces

A root with `workspaces` (a `game/` or `mcp/` package, say) makes bun install packages in an
isolated layout, and `email:build` then cannot resolve Maizzle's own `@maizzle/tailwindcss`
from `emails/`. Add `@maizzle/tailwindcss` as a direct devDependency of the root. woolholm
hit this on its first sync.

## Transactional Email

The functions that build each email are in `server/utils/email-templates.ts`. The sign-in link is the
one load-bearing email rather than a courtesy: `POST /api/auth/magic-link` inspects
`sendEmail()`'s result and 503s in production rather than claiming to have sent one.

`sendEmail()` (Resend over fetch) **never throws** — it's always called from
something more important than the email, and a mail outage must not 500 a login
or make Stripe replay a money event. Unset `NUXT_RESEND_API_KEY` = logged no-op.

**It enqueues rather than POSTs when the `EMAIL_QUEUE` binding exists** (production
and preview, never `bun dev` — the dev preset has no `queue()` handler, so a local
enqueue is a black hole that reports success). `server/utils/email-queue.ts` owns
that decision and the pure retry/dead-letter logic;
`server/plugins/email-queue-consumer.ts` does the delivery. Three invariants:
the unconfigured check runs **before** the enqueue, a failed enqueue falls back to
an inline send, and the message body carries the built request but never the API
key. Mandatory-mail and unsubscribe semantics are decided by
`buildResendEmailRequest()` before anything is queued — don't re-decide them in
the consumer.

Five rules that each cost real mail when they were broken:

- **`inline: true` is the opt-out, and only two callers get it.** A queued send
  reports `sent: true` at enqueue, so any caller whose contract is "did this
  actually send" must bypass the queue: `POST /api/auth/magic-link` (owes a 503)
  and `POST /api/feedback/:id/reply` (stamps `replied_at`). Everything else stays
  queued.
- **One classifier, both paths.** `classifyResendResponse()` is shared by the
  inline POST and the consumer, and both log `email_permanent_failure` /
  `email_transient_failure` with a `path` field. Don't add a third vocabulary: a
  4xx and a 503 mean different things, and inline maps them to `rejected` and
  `error` respectively — that distinction is what magic-link's 503 branch reads.
- **The consumer's expected queue name is a `var`, never a constant.**
  `NUXT_EMAIL_QUEUE_NAME` differs between `[vars]` and `[env.preview.vars]`. As a
  constant it matched production and silently missed preview — and a consumer
  that skips a batch **acks it by omission**, so every preview email was
  destroyed with no log line. Unexpected queues are logged, never skipped quietly.
- **`EMAIL_QUEUE_MAX_ATTEMPTS` is `max_retries` + 1.** `max_retries` counts
  retries, so a message is delivered up to four times.
- **`compatibility_flags` pins `queue_consumer_wait_for_wait_until`.** Every
  `ack()`/`retry()` runs inside `waitUntil` after the handler returned; the
  opposite flag would turn `retry()` into a silent no-op. Don't remove it.

Billing emails are decided by `layers/billing/server/utils/billing-notifications.ts` › `decideNotification` on **status transitions**,
not on events: Stripe fires `customer.subscription.updated` for trivial changes, and
emailing per event trains people to filter you — taking the payment-failed email
with it. Add a case to that function, not an ad-hoc send in a handler.

---



<!-- forkless:lifecycle:start -->

## Lifecycle email

`server/utils/lifecycle.ts` sends "did X, not Y within N days" email once a day
(`server/tasks/lifecycle-email.ts`, on the 04:00 cron). A step is a `due()` query
plus a template; the runner owns preferences, undeliverable addresses, the per-run
cap, the `lifecycle_email_sent` event, and once-only delivery through a
`lifecycle_sends` row claimed before the send.

- **The sequence is data, in one file: `server/utils/lifecycle-sequence.ts`.** Each
  entry is one email: an `id`, the preference it obeys, a clock (`since: 'signup'` or
  `'last_sign_in'`), `afterDays`, `forDays`, an optional `when` (`activated`,
  `not_activated`), and its copy (`subject`, `heading`, `paragraphs`, `button`,
  `footnote`). To change wording, a delay or who gets a step, or to add one, edit
  that file and nothing else; `lifecycle-definitions.ts` builds the query and
  renders the copy through the shared `note` email. The app owns the file
  (`app-owned.json`), so a template sync never overwrites it. It ships `welcome`
  (at sign-up) and `activation_nudge` (1–7 days after sign-up, never activated)
  switched on, and `win_back` (45–59 days after the last sign-in) switched off.
- **`enabled: false` holds a step back without deleting it.** `win_back` ships that
  way so that syncing the template never starts mailing dormant accounts. To send
  it, delete the `enabled: false` line from the `win_back` entry in your copy of
  the file. The first run after that mails every account whose last sign-in was
  45 to 59 days ago, so read the copy first.
- **`test/lifecycle-sequence.test.ts` is the gate on that file**: a mandatory
  notification class, an unbounded window, an unknown `{{tag}}` (only `{{appName}}`
  and `{{name}}` exist), an off-site button or urgency wording fails the build.
- **A zero-day sign-up step is sent at sign-up**, by `server/plugins/lifecycle.ts`
  through the same claim and checks; the daily run retries it inside its window.
- **Feature steps** register with `registerLifecycleStep()`: billing's
  `pass_expiring` (mandatory `billing.pass_expiring`; a paid pass ends within 3
  days with nothing behind it).
- **A step that needs its own query** is code, in `lifecycle-app-steps.ts`, which
  the template ships empty.
- **Bound every window on both sides.** "Signed up more than a day ago" mails the
  whole user table the day Resend is first configured. `forDays` is that bound.
- **Never rename a step id.** The id is the dedup key; a rename re-sends to everyone.
- With Resend unconfigured the task logs `lifecycle_skipped` and does nothing.
- Every button link carries `utm_source=email`, `utm_medium=lifecycle` and
  `utm_campaign=<step id>`, so a click is attributable to the step.

## Announcements

An announcement is one markdown file, `content/announcements/<id>.md`. Merging it
is what sends it: the daily task (`server/utils/announcements.ts`) sends each
announcement that has no finished run, once, to everyone who allows product mail.

```
---
subject: Exports are here
date: 2026-11-25
audience: everyone
button_label: See what changed
button_path: /changelog
---

Plain paragraphs, separated by blank lines.
```

- **Fields.** `subject` and `date` are required. `date` is the first day the send
  may start; a file found more than 14 days after it is closed unsent, so an old
  announcement never goes out late. `audience` is `everyone` (the default:
  accounts, then confirmed subscribers), `users`, `activated` or `subscribers`.
  `heading` defaults to the subject. The button is optional and its path is on
  this app. The body is plain text: no markdown, no `{{tags}}`.
- **The filename is the id**, stored as the step `announcement.<id>` (lowercase,
  digits, hyphens, 27 characters at most). Never rename a sent one.
- **CI gates it.** `bun run email:build` (in `bun run ci`) parses every file with
  `scripts/announcement-source.ts` and fails on a missing field, an unknown one,
  markdown in the body or urgency wording (`shared/utils/announcements.ts` ›
  `findUrgency`).
- **Who gets it.** Accounts with the `product_updates` preference on (the default;
  its switch is on `/account` and its unsubscribe link in every send), and
  confirmed subscribers. Never an unconfirmed address, a deleted account, or
  anyone who arrived after the send started.
- **The weekly cap** is `ANNOUNCEMENTS_PER_WEEK` in `lifecycle-sequence.ts`: the
  announcements one person may get in seven days. A send over it is skipped and
  counted (`announcement_runs.capped`, `email.capped` on `/api/fleet`), not held
  for later: the run moves its cursor past that person and never returns.
- **Once.** Each send is claimed first, in `lifecycle_sends` for an account and
  `subscriber_sends` for a subscriber. A send that fails for a passing reason
  stops the run there, and the next day resumes at the same person.
- 100 people per run across all announcements; a longer list continues the next day, and a
  run still open after 14 days is closed. A list past about 1,400 needs a different sender.

<!-- forkless:lifecycle:end -->

## Product updates for visitors

`<UpdatesForm />` (`app/components/Updates/Form.vue`) lets a visitor with no account
ask for product news; `server/utils/subscribers.ts` is the whole of it.

- **Double opt-in.** `POST /api/email/updates` stores the address unconfirmed and
  sends the `subscribe-confirm` email, the only mail an unconfirmed address ever
  gets. Its link opens `/updates/confirm`, whose button POSTs the confirmation
  (a GET confirms nothing: mail gateways fetch links). An address not confirmed
  within 7 days is deleted by the daily purge.
- **Guarded like the sign-in form**: a per-IP rate limit, Turnstile when
  configured, and a budget of 3 confirmation emails per address per day, charged
  silently. The route answers `{ ok: true }` whatever happened to the address.
- **Unsubscribing deletes the row.** Every announcement to a subscriber carries
  `List-Unsubscribe` (one-click POST) and a footer link to `/unsubscribe`. No
  address is kept on a suppression list, so a deletion request is the same link.
- **Accounts win.** An address with an account is never mailed as a subscriber.
  Confirming for one switches that account's `product_updates` on and drops the
  row; signing up drops the row too.
- Links are HMACs under the key `unsubscribe.ts` derives (`subscriber-tokens.ts`);
  there is no secret to set.
- `/api/fleet` reports `email.subscribers: { confirmed, pending }`. Counts only.

