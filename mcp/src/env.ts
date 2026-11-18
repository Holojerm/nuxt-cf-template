import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

// Bindings from wrangler.jsonc, plus OAUTH_PROVIDER injected by OAuthProvider
// into the defaultHandler's env.
export interface Env {
  DB: D1Database
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers
  /**
   * The domain-verification token ChatGPT's submission portal issues, served by
   * discovery.ts at `/.well-known/openai-apps-challenge`. Public by design, so
   * it is a plain var in wrangler.jsonc rather than a secret. Empty = 404.
   */
  OPENAI_APPS_CHALLENGE?: string
  /**
   * The app's origin, where /authorize sends a browser to sign in. Unset in
   * production, where it is `fleet.json › urls.prod`; set it in `.dev.vars`
   * to point `wrangler dev` at a local app.
   */
  APP_URL?: string
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
  /**
   * The client's registered name ("Claude", "Cursor"), for a tool that records
   * who made a change. A label the client chose for itself, not an identity:
   * never authorize on it. Optional for the same reason as `grantedAt`.
   */
  clientName?: string
}
