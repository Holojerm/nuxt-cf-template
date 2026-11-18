// nuxt-auth-utils types its OAuth and WebAuthn callback events as the portable
// `RequestEvent` from `nuxt/server`, while every server util here takes h3 v1's
// `H3Event`. Under `@nuxt/nitro-server` (Nuxt 4) they are the same object:
// `defineEventHandler` from `nuxt/server` returns the handler unchanged, so Nitro
// hands it the H3Event. These two casts are the only place that is assumed.
// They go when the server moves to `nuxt/server` wholesale (Nuxt 5).

import type { H3Event } from 'h3'
import type { RequestEvent } from 'nuxt/server'

export function h3Event(event: RequestEvent): H3Event {
  return event as unknown as H3Event
}

export function requestEvent(event: H3Event): RequestEvent {
  return event as unknown as RequestEvent
}
