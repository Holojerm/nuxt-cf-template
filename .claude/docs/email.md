# Transactional email

How an email is written (Maizzle templates, compiled at build time, filled in with Mustache), Resend over fetch, the `EMAIL_QUEUE` enqueue path, retry and dead-letter semantics, and why billing mail is decided on status transitions rather than on webhook events. Five rules here each cost real, undelivered mail when they were broken.

> **Load this when:** touching `emails/`, `server/utils/email*.ts`, `server/plugins/email-queue-consumer.ts`, notification preferences, or adding any new outbound email.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Writing an email

Markup lives in [`emails/`](../../emails), written in [Maizzle 6](https://maizzle.com/docs)
(Vue single-file templates, Tailwind 4). **Maizzle runs at build time only** — it needs Node, Vite
and a CSS toolchain, so it is a devDependency and nothing from it reaches the Worker.
`bun run email:build` compiles every template to `server/emails/generated.ts`, a committed
module of `{ [name]: { html, text } }` strings that still contain `{{mustache}}` tags.
At send time `renderEmail(name, data)` in
[`server/utils/render-email.ts`](../../server/utils/render-email.ts) fills them in.

```
emails/
  templates/welcome.vue     the HTML — content only
  templates/welcome.txt     the plain-text alternative, same tags
  components/Email*.vue     the chrome: EmailLayout, EmailParagraph, EmailButton
  samples.ts                sample data per template — previews and tests
  theme.generated.css       GENERATED from DESIGN.md — see Branding
  maizzle.config.ts
server/emails/generated.ts  GENERATED — commit it
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

`bun run email:check` (in `bun run ci`) rebuilds in memory and fails if the committed module
differs; it needs no browser, so it runs in the Workers Builds image. It also fails the build when:
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
  see the tone bar in `emails/templates/ops-digest.vue`.
- **Don't hand-format `emails/**/*.vue`** — it is excluded from `oxfmt`, which splits
  `</Raw>` across lines and breaks Maizzle's extraction.

### Plain text

Each email has a hand-written `.txt`, not Maizzle's `plaintext` feature. Its output is derived
from the HTML after CSS inlining and merges adjacent paragraphs onto one line, renders links as
`label\n\nurl`, and — the deciding case — turns a `{{#rows}}` loop into one run-on line, because
section tags are text to it and not the standalone lines Mustache needs to remove them. A `.txt`
is the format the ops digest's bullets and `…and N more` line need, and it is the one thing a
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

### Ops digest

`server/utils/ops-digest.ts` renders `emails/templates/ops-digest.*` and imports nothing from
the transactional stack except `render-email.ts` — forks that tore out transactional email
(TEARDOWN.md) keep their alerts, so keep it that way.

---

## Transactional Email

The functions that build each email are in `server/utils/email-templates.ts`, except the
sign-in link, which
lives in `server/utils/auth-email-templates.ts` because it is the one email that is
load-bearing rather than a courtesy — `POST /api/auth/magic-link` inspects
`sendEmail()`'s result and 503s in production rather than claiming to have sent one.

`sendEmail()` (Resend over fetch) **never throws** — it's always called from
something more important than the email, and a mail outage must not 500 a login
or make Paddle replay a money event. Unset `NUXT_RESEND_API_KEY` = logged no-op.

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

Billing emails are decided by `decideNotification()` on **status transitions**,
not on events: Paddle fires `subscription.updated` for trivial changes, and
emailing per event trains people to filter you — taking the payment-failed email
with it. Add a case to that function, not an ad-hoc send in a handler.

---



## Lifecycle email

`server/utils/lifecycle.ts` sends "did X, not Y within N days" email once a day
(`server/tasks/lifecycle-email.ts`, on the 04:00 cron). A step is a `due()` query
plus a template; the runner owns preferences, undeliverable addresses, the per-run
cap, the `lifecycle_email_sent` event, and once-only delivery through a
`lifecycle_sends` row claimed before the send.

- **Template steps** (`lifecycle-steps.ts`): `activation_nudge` (optional `tips`
  preference; signed up 1–7 days ago, never activated) and `pass_expiring`
  (mandatory `billing.pass_expiring`; a paid pass ends within 3 days with no
  subscription or later pass behind it — with auto-renew off by default, this is
  the only warning a customer gets).
- **Fork steps** go in `lifecycle-app-steps.ts`, which the template ships empty.
  A win-back belongs there, keyed on whatever "used the product" means.
- **Bound every window on both sides.** "Signed up more than a day ago" mails the
  whole user table the day Resend is first configured.
- **Never rename a step id.** The id is the dedup key; a rename re-sends to everyone.
- With Resend unconfigured the task logs `lifecycle_skipped` and does nothing.
