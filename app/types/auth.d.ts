// Shape the User/UserSession from nuxt-auth-utils so `useUserSession()` returns
// a typed user.
//
// This interface must mirror what the server actually writes — see the
// setUserSession call in server/utils/auth.ts › establishSession. Adding a key
// here without adding it there gives you a field that type-checks and is always
// undefined at runtime, which is worse than not having it.
//
// Keep the session small. It's a sealed cookie sent on every request, so it
// holds identity, not state: read entitlements from the DB
// (server/utils/billing.ts), never from the session, or a user who cancels
// keeps their access until the cookie expires.

declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
    avatarUrl: string | null
    /** 'user' | 'admin' — set by us, never by the identity provider. */
    role: string
  }

  interface UserSession {
    user: User
    /**
     * Unix seconds at which this session was sealed.
     *
     * The half of session revocation that lives in the cookie: `users.
     * sessions_invalid_before` says when an account's sessions died, and this
     * says whether THIS one predates that. Without it a sealed cookie is
     * unfalsifiable — there is no server-side session record to delete, so
     * "sign out everywhere" and "this account was deleted" would both be
     * unenforceable. Checked on every authenticated request by
     * server/middleware/auth.ts.
     *
     * Optional because sessions sealed before this shipped don't carry it. The
     * guard treats a missing value as revoked *only* when the account has a
     * revocation instant set, so nobody is logged out by the upgrade itself.
     */
    issuedAt?: number
  }
}

export {}
