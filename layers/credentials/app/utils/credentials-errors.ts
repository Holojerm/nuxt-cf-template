// The sentence for each code the layer's routes return. Anything else falls
// through to core's table (app/utils/auth-errors.ts): rate limits, Turnstile.

const CREDENTIALS_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong email or password.',
  wrong_password: "That isn't your current password.",
  no_password: 'This account has no password yet. Use "Forgot password" to set one.',
  already_registered:
    'This address already has an account. Sign in, or reset your password if you have forgotten it.',
  weak_kdf: 'This page is out of date. Reload it and try again.',
  link_expired: 'That link has expired. Request a new one.',
  link_used: 'That link has already been used. Request a new one.',
  link_invalid: "We don't recognise that link. Request a new one and open it directly.",
  passkey_expired: 'That took too long. Try again.',
  passkey_unknown: "We don't recognise that passkey. Sign in another way and add it again.",
  passkey_rejected: "That passkey couldn't be verified. Try again, or sign in another way.",
  passkey_limit: 'Remove a passkey before adding another.',
  passkey_cancelled: 'The passkey prompt was dismissed. Try again when you are ready.',
}

export function credentialsErrorCode(error: unknown): string {
  // What the browser throws when a WebAuthn prompt is dismissed or times out.
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return 'passkey_cancelled'
  return authErrorCode(error)
}

export function credentialsErrorMessage(error: unknown): string {
  const code = credentialsErrorCode(error)
  return (
    (Object.hasOwn(CREDENTIALS_ERROR_MESSAGES, code) ? CREDENTIALS_ERROR_MESSAGES[code] : null) ??
    authErrorMessage(code) ??
    'Something went wrong. Try again.'
  )
}
