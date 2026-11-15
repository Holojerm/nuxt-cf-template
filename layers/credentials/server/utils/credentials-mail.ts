// Send one of the layer's links, and say what the route should do about a failure.

import { db } from '@nuxthub/db'

import { sendEmail } from '#server/utils/email'
import { emailBranding } from '#server/utils/email-templates'
import { logEvent } from '#server/utils/log'
import { passwordResetEmail, verifyEmailEmail } from './credentials-emails'
import { CREDENTIAL_TOKEN_TTL_SECONDS, discardCredentialToken } from './credentials-tokens'
import type { CredentialTokenPurpose } from './credentials-tokens'

/** The page each link opens. The token rides in the fragment, so it reaches no log or Referer. */
const LINK_PATH: Record<CredentialTokenPurpose, string> = {
  verify: '/auth/verify-email',
  reset: '/auth/reset',
}

export interface CredentialLinkOutcome {
  /** False only when the mail provider is down: the caller decides whether to say so. */
  delivered: boolean
  /** Dev only, and only with no mail provider configured: the link, for the page to show. */
  devLink?: string
}

/**
 * `inline`: both callers owe an honest answer about whether mail left, and a
 * queued send reports success at enqueue (.claude/docs/email.md).
 */
export async function sendCredentialLink(
  purpose: CredentialTokenPurpose,
  input: { to: string; token: string; recordId: string },
): Promise<CredentialLinkOutcome> {
  const brand = emailBranding()
  const url = `${brand.appUrl}${LINK_PATH[purpose]}#token=${encodeURIComponent(input.token)}`
  const expiresMinutes = CREDENTIAL_TOKEN_TTL_SECONDS[purpose] / 60
  const content =
    purpose === 'verify'
      ? verifyEmailEmail(brand, { url, expiresMinutes })
      : passwordResetEmail(brand, { url, expiresMinutes })

  const result = await sendEmail({ to: input.to, inline: true, ...content })
  if (result.sent) return { delivered: true }

  if (import.meta.dev && process.env.NODE_ENV !== 'production') {
    logEvent('info', 'credentials_link_dev', { purpose, reason: result.reason, url })
    return { delivered: true, devLink: url }
  }

  // Nobody will ever hold this token; do not leave it spendable.
  await discardCredentialToken(db, input.recordId)
  logEvent('error', 'credentials_link_undeliverable', { purpose, reason: result.reason })
  // A provider that rejected THIS address is not an outage: answer as if sent,
  // or the response says which addresses bounce.
  return { delivered: result.reason === 'rejected' }
}
