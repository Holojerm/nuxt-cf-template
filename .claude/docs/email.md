# Transactional email

Resend over fetch, the `EMAIL_QUEUE` enqueue path, retry and dead-letter semantics, and why billing mail is decided on status transitions rather than on webhook events. Five rules here each cost real, undelivered mail when they were broken.

> **Load this when:** touching `server/utils/email*.ts`, `server/plugins/email-queue-consumer.ts`, notification preferences, or adding any new outbound email.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

## Transactional Email

Templates live in `server/utils/email-templates.ts`, except the sign-in link, which
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


