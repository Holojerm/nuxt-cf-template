// The two links a subscriber is mailed (server/utils/subscribers.ts): confirm,
// and unsubscribe. Each token is an HMAC under the key unsubscribe.ts derives
// from the session password, so there is no secret to set and nothing stored to
// look up. The purpose is part of the signed message: a confirmation token is
// never valid as an unsubscribe token, or the other way round.

import { timingSafeEqual } from './hash'
import { hmacBase64Url } from './unsubscribe'

export type SubscriberTokenPurpose = 'confirm' | 'leave'

const message = (purpose: SubscriberTokenPurpose, id: string) => `subscriber:${purpose}|${id}`

export const signSubscriberToken = (
  sessionPassword: string,
  purpose: SubscriberTokenPurpose,
  id: string,
): Promise<string> => hmacBase64Url(sessionPassword, message(purpose, id))

export async function verifySubscriberToken(
  sessionPassword: string,
  purpose: SubscriberTokenPurpose,
  id: string,
  token: string,
): Promise<boolean> {
  return timingSafeEqual(await signSubscriberToken(sessionPassword, purpose, id), token)
}

const origin = (appUrl: string) => appUrl.replace(/\/+$/, '')

/** The confirmation page. Parameters ride in the fragment, which no server logs. */
export async function buildSubscriberConfirmUrl(
  sessionPassword: string,
  appUrl: string,
  id: string,
): Promise<string> {
  const params = new URLSearchParams({
    s: id,
    t: await signSubscriberToken(sessionPassword, 'confirm', id),
  })
  return `${origin(appUrl)}/updates/confirm#${params.toString()}`
}

/** The List-Unsubscribe target: a mail provider POSTs it (RFC 8058), a person GETs it. */
export async function buildSubscriberUnsubscribeUrl(
  sessionPassword: string,
  appUrl: string,
  id: string,
): Promise<string> {
  const params = new URLSearchParams({
    s: id,
    t: await signSubscriberToken(sessionPassword, 'leave', id),
  })
  return `${origin(appUrl)}/api/email/updates/unsubscribe?${params.toString()}`
}
