// The credentials layer: password and passkey sign-in where the browser derives
// the sign-in proof, so the server never receives the password, and keeps a
// second derived key (the unlock key) that it hands to the app through the
// `credentials:unlock` hook. Off until `enabled` is set: with it false every
// route and page here answers 404 and core's magic link is the only door.
//
// Expects the app to provide core's auth session, rate limiting, Turnstile,
// email (server/utils/email.ts and the `verify-email` / `password-reset`
// templates under emails/) and extension seams. Auto-registered because it
// lives under layers/. Docs: .claude/docs/credentials.md.
//
// Set in the app's own nuxt.config, or by env, never by editing this file:
//   NUXT_PUBLIC_CREDENTIALS_ENABLED     true turns the layer on
//   NUXT_PUBLIC_CREDENTIALS_PRIMARY     true sends /login to /auth/sign-in
//   NUXT_PUBLIC_CREDENTIALS_PRF         true asks passkeys for the PRF extension
//   NUXT_PUBLIC_CREDENTIALS_ITERATIONS  PBKDF2 rounds for NEW passwords
export default defineNuxtConfig({
  $meta: { name: 'credentials' },
  // Registers nuxt-auth-utils' WebAuthn handlers (and checks both
  // @simplewebauthn packages are installed).
  auth: { webAuthn: true },
  runtimeConfig: {
    public: {
      credentials: {
        enabled: false,
        primary: false,
        prf: false,
        iterations: 600_000,
      },
    },
  },
})
