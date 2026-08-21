// Client half of the feedback loop.
//
// Submitting posts to /api/feedback (public — signed-out visitors included) and
// enriches the payload with the two things only the browser knows: the route
// the user is on, and their PostHog identity + a deep link to the session
// replay of this exact moment. The server does the PostHog capture, so a
// blocked SDK can never lose the event and it can't be double-counted.
//
// Programmatic prompts (post-cancellation "why did you leave?", post-onboarding
// CSAT) call submit() directly with a `rating`; the widget leaves it null.

import type { PostHog } from 'posthog-js'

export interface FeedbackPayload {
  /** bug | idea | praise | confusion | other — validated server-side. */
  kind: string
  message: string
  /** 1–5 satisfaction score, for prompts that ask for one. */
  rating?: number | null
  /** Reply-to address — only worth collecting from signed-out submitters. */
  email?: string | null
}

export function useFeedback() {
  const route = useRoute()
  const pending = ref(false)
  const error = ref<string | null>(null)

  /** Undefined whenever posthogKey is unset — the whole plugin no-ops then. */
  function posthog(): PostHog | undefined {
    return useNuxtApp().$posthog as PostHog | undefined
  }

  /** Deep link to the replay of what the user was doing, if recording is on. */
  function sessionReplayUrl(): string | null {
    return posthog()?.get_session_replay_url({ withTimestamp: true }) ?? null
  }

  async function submit(payload: FeedbackPayload): Promise<boolean> {
    pending.value = true
    error.value = null
    try {
      await $fetch('/api/feedback', {
        method: 'POST',
        body: {
          kind: payload.kind,
          message: payload.message,
          rating: payload.rating ?? null,
          email: payload.email || null,
          path: route.fullPath,
          replayUrl: sessionReplayUrl(),
          posthogDistinctId: posthog()?.get_distinct_id() ?? null,
        },
      })
      return true
    } catch (err) {
      const failure = err as { data?: { message?: string }; statusMessage?: string }
      error.value =
        failure.data?.message ?? failure.statusMessage ?? 'Could not send that — try again.'
      return false
    } finally {
      pending.value = false
    }
  }

  return { submit, pending, error, sessionReplayUrl }
}
