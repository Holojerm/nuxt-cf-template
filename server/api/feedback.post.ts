// Submit feedback. Public on purpose — signed-out visitors have opinions too,
// and the single biggest killer of a feedback loop is making people log in to
// use it. The global auth middleware allowlists this exact method + path.
//
// Two things happen per submission:
//   1. A row in D1 (yours forever, joinable against users/entitlements).
//   2. A PostHog `feedback_submitted` event on the submitter's distinct id, so
//      the feedback lands on their person timeline next to the session replay
//      of what they were doing when they wrote it.
//
// Capture is server-side only — the client passes the replay URL and distinct
// id but does not capture, so ad blockers can't drop the event and it can't be
// double-counted.
//
// Two limits guard the anonymous path, and they answer different questions:
// the D1 ip_hash counter below decides how fast one source may submit, and
// Turnstile decides whether there is a browser on the other end at all.

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, feedbackSubmissionSchema.parse)

  const session = await getUserSession(event)
  const userId = session.user?.id ?? null

  // Anonymous submitters get a bot check; signed-in ones already cleared OAuth.
  //
  // Scoping it to `!userId` is not a convenience. useFeedback().submit() is also
  // called programmatically — the cancellation prompt on /account asks why
  // someone is leaving, with no widget anywhere on screen — and requiring a
  // token unconditionally would turn every one of those into a 400 the moment a
  // fork configured Turnstile. The abuse surface is the anonymous one anyway.
  //
  // No-ops entirely without NUXT_TURNSTILE_SECRET_KEY. See server/utils/turnstile.ts.
  if (!userId) await requireTurnstile(event, body.turnstileToken)

  const ip = getHeader(event, 'cf-connecting-ip') ?? getRequestIP(event, { xForwardedFor: true })
  const ipHash = await hashIp(ip, useRuntimeConfig(event).sessionPassword)

  if (await isRateLimited(db, ipHash)) {
    throw createError({
      statusCode: 429,
      message: 'Thanks — that’s a lot of feedback. Try again in an hour.',
    })
  }

  const row = await recordFeedback(db, body, {
    userId,
    ipHash,
    userAgent: getHeader(event, 'user-agent') ?? null,
  })

  // The message text is included so feedback is readable in PostHog without a
  // DB round-trip. Drop this property if your privacy posture says analytics
  // must never hold user-authored text — the D1 row is the system of record.
  void captureServerEvent({
    distinctId: body.posthogDistinctId || userId || `feedback-${row.id}`,
    event: 'feedback_submitted',
    properties: {
      feedback_id: row.id,
      feedback_kind: row.kind,
      feedback_message: row.message.slice(0, 500),
      feedback_rating: row.rating,
      feedback_path: row.path,
      authenticated: Boolean(userId),
      $session_recording_url: row.replayUrl,
    },
  })

  return { id: row.id, status: 'received' as const }
})
