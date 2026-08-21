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
  }
}

export {}
