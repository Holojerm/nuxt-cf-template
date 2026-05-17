// Shape the User/UserSession from nuxt-auth-utils so `useUserSession()` returns
// a typed user. Mirror server-side session writes: whatever you pass to
// `setUserSession(event, { user: {...} })` must match this interface.
//
// Extend `User` as your auth grows (roles, avatar URL, etc.) — keep the keys
// in sync with the server handler that issues the session.

declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
  }

  interface UserSession {
    user: User
  }
}

export {}
