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
}
