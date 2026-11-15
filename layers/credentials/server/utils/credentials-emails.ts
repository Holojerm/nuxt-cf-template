// The layer's two emails. The markup is core's (emails/templates/verify-email
// and password-reset): email:build compiles one directory.

import { composeEmail } from '#server/utils/email-templates'
import type { Branding, EmailContent } from '#server/utils/email-templates'

export interface CredentialLinkEmail {
  url: string
  expiresMinutes: number
}

export function verifyEmailEmail(brand: Branding, opts: CredentialLinkEmail): EmailContent {
  return composeEmail('verify-email', `Finish creating your ${brand.appName} account`, brand, {
    url: opts.url,
    expiresMinutes: opts.expiresMinutes,
  })
}

export function passwordResetEmail(brand: Branding, opts: CredentialLinkEmail): EmailContent {
  return composeEmail('password-reset', `Reset your ${brand.appName} password`, brand, {
    url: opts.url,
    expiresMinutes: opts.expiresMinutes,
  })
}
