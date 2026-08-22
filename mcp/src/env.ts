import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

// Bindings from wrangler.jsonc, plus OAUTH_PROVIDER injected by OAuthProvider
// into the defaultHandler's env.
export interface Env {
  DB: D1Database
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers
}

// Application props attached to every grant at completeAuthorization() and
// read back in tools via getMcpAuthContext().
export interface AuthProps extends Record<string, unknown> {
  userId: string
  /**
   * When this grant was issued, in Unix SECONDS — the same unit and the same
   * job as `issuedAt` on the app's sealed session cookie.
   *
   * It exists so a grant can be revoked. An OAuth grant lives in this worker's
   * OAUTH_KV and nothing in the app can reach it, so without a date on it there
   * is no way to say "everything issued before I deleted my account is dead".
   * Compared against `users.sessions_invalid_before` in server.ts.
   *
   * Optional because grants issued before this field existed do not carry it.
   * They are refused rather than trusted, but only for accounts that have
   * actually revoked something — see loadAuthorizedUser().
   */
  grantedAt?: number
}
