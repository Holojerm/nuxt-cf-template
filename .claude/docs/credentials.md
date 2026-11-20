# Credentials: passwords and passkeys

The credentials layer (`layers/credentials/`): sign-up and sign-in with a password the server never receives, passkeys, email verification, password reset, and a client hook that hands the app the keys the browser derived. It is **off until an app turns it on**; core's magic link stays the default.

> **Load this when:** touching `layers/credentials/`, building anything on the unlock key or a passkey's PRF output, or making passwords the app's only sign-in.
> Canonical index: [AGENTS.md](../../AGENTS.md). Sessions, `rateLimit()` and Turnstile are in [auth.md](auth.md).

---

## Turning it on

```ts
// nuxt.config.ts › runtimeConfig.public
credentials: { enabled: true },                    // beside the magic link
credentials: { enabled: true, primary: true },     // /login becomes /auth/sign-in
```

| Option (`NUXT_PUBLIC_CREDENTIALS_*`) | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | While false every route and page of the layer answers 404 |
| `primary` | `false` | Redirects `/login` to `/auth/sign-in`, so core's guards need no change |
| `prf` | `false` | Asks passkeys for the PRF extension (below) |
| `iterations` | `600000` | PBKDF2 rounds for **new** passwords; the server refuses fewer |

A fork vendors it with `bun run layers:pull credentials`, adds `export * from '../../layers/credentials/server/db/schema'` to `server/db/schema.ts`, and runs `bun run db:generate`. It needs `@simplewebauthn/server` and `@simplewebauthn/browser` (^11, the range `nuxt-auth-utils` 0.5 accepts) in `package.json`. Nothing in core links to the layer's pages: link `/settings/security` from your account page or menu. Making it the only sign-in is the "Credentials only" recipe in the repo's TEARDOWN checklist.

## What is where

| | Where |
| --- | --- |
| Derivation (PBKDF2, the proof/unlock split), request schemas | `layers/credentials/shared/utils/credentials-kdf.ts`, `credentials-schemas.ts` |
| Client: `signUp`, `completeSignUp`, `signIn`, `unlock`, `changePassword`, `requestReset`, `completeReset` | `layers/credentials/app/composables/useCredentials.ts` |
| Client: passkeys, and the ceremony with PRF | `layers/credentials/app/composables/usePasskeys.ts`, `layers/credentials/app/utils/passkey-ceremony.ts` |
| The client hook's types | `layers/credentials/app/utils/credentials-unlock.ts` |
| Pages | `/auth/sign-in`, `/auth/sign-up`, `/auth/verify-email`, `/auth/reset`, `/settings/security` |
| Public routes (no session) | `layers/credentials/server/api/auth/credentials/` |
| Signed-in routes | `layers/credentials/server/api/credentials/` |
| Proof storage and verification | `layers/credentials/server/utils/credentials-password.ts` |
| The params lookup | `layers/credentials/server/utils/credentials-params.ts` |
| Mailed tokens, the mail budget | `layers/credentials/server/utils/credentials-tokens.ts` |
| Server hooks | `layers/credentials/server/utils/credentials-hooks.ts` |
| Every rate limit | `layers/credentials/server/utils/credentials-limits.ts` |
| Tables: `credential_passwords`, `credential_passkeys`, `credential_tokens`, `credential_challenges` | `layers/credentials/server/db/schema.ts` |
| **Stays in core** | the two emails (`emails/templates/verify-email.*`, `password-reset.*`: `email:build` compiles one directory); sessions and `users.sessions_invalid_before`; `getIdentitySalt()` |

## What the browser derives

```
master = PBKDF2-SHA256(NFKC(password), salt, iterations)      32 bytes, never leaves the module
proof  = HKDF-SHA256(master, info "credentials/v1/sign-in-proof")   sent to the server
unlock = HKDF-SHA256(master, info "credentials/v1/unlock-key")      handed to the app, never sent
```

The salt is 16 random bytes per account, chosen by the browser when a password is set. The server stores `hashPassword(proof)` (scrypt, from `nuxt-auth-utils`) with the salt and the iteration count. It cannot compute `unlock` from `proof`: the two HKDF outputs are independent. The layer encrypts nothing itself. An app that ignores the hook gets ordinary password sign-in.

- **The server cannot enforce a password policy**, because it never sees one. The 10-character minimum is in the form (`CREDENTIALS_MIN_PASSWORD_LENGTH`).
- **Raising `iterations`** applies to passwords set afterwards. An existing account keeps its count until its password is next changed or reset.
- scrypt costs tens of milliseconds of CPU per sign-in. That fits a paid Workers plan and not the free plan's 10 ms limit.

## The client hook: `credentials:unlock`

```ts
// app/plugins/keys.client.ts in a fork
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('credentials:unlock', async (unlock) => {
    // unwrap or wrap the account's keys here
  })
})

interface CredentialsUnlock {
  reason: 'sign-up' | 'sign-in' | 'unlock' | 'password-change' | 'password-reset' | 'password-set' | 'passkey-sign-in' | 'passkey-register'
  userId: string
  unlockKey: Uint8Array | null          // 32 bytes; null on a passkey ceremony, a passkey sign-up included
  previousUnlockKey: Uint8Array | null  // 'password-change' only
  passkey: {
    credentialId: string
    prf: Uint8Array | null              // 32 bytes when prfStatus is 'provided'
    prfStatus: 'provided' | 'unavailable' | 'not-requested'
  } | null
}
```

`onCredentialsUnlock(handler)` is the same thing as a composable. The hook is awaited: the composable that fired it, and the navigation after it, wait for every listener. It fires after the server accepted the proof and before the reactive session refreshes, so the cookie is already set and a listener can call the app's own API. A listener that throws rejects the composable call; the session is already established by then.

| `reason` | Fired by | Carries |
| --- | --- | --- |
| `sign-up` | `useCredentials().completeSignUp()` or `usePasskeys().createAccount()`, on the page the mailed link opens: the account now exists | `unlockKey` for a password, `passkey` (and no `unlockKey`) for a passkey |
| `sign-in` | `useCredentials().signIn()` | `unlockKey` |
| `unlock` | `useCredentials().unlock(password)`, for someone signed in who has not typed a password: a passkey without PRF | `unlockKey`, after the server confirmed the password |
| `password-change` | `changePassword()` | both keys, to re-wrap |
| `password-reset` | `completeReset()` | the new `unlockKey` only: the old one is gone |
| `password-set` | `setPassword()`: a first password for an account made with a passkey | the new `unlockKey` |
| `passkey-sign-in`, `passkey-register` | `usePasskeys()` | `passkey` |

Sign-up is email first. `signUp({ email })` only mails a link and fires nothing; the password is chosen on the page the link opens, by whoever holds the mailbox, and that is when the account is created and `sign-up` fires with its first unlock key. Asking for the password with the address would let anyone start a sign-up for someone else's address with a password of their own.

**A passkey instead of a password.** Where the browser can make a passkey (and, with `prf` on, does not report that it lacks PRF), the page the link opens offers "Continue with Face ID or Touch ID" (or Touch ID, Windows Hello, the phone's screen lock: `passkey-device.ts` names it from the user agent, for wording only) above "Use a password instead". `POST /api/auth/credentials/verify-passkey` is a register ceremony that the token stands in for a session on: its first call reads the token without spending it, to learn the address; its second spends it, creates the account, saves the passkey and signs in. With `prf` on, the browser fetches the PRF output before the second call and stops if there is none (`passkey_prf_unavailable`), so the link still works for a password and no account exists without a secret the app can wrap its keys under. Such an account has no password; `/settings/security` lets its session set a first one (`POST /api/credentials/password/first`, `setPassword()`), with no mail, because a session can already add a passkey and a password grants nothing more. A sign-up link for an address that already signs in with a password or a passkey is refused (`already_registered`).

## Passkeys and PRF

Registration and sign-in run through `nuxt-auth-utils`' `defineWebAuthnRegisterEventHandler` and `defineWebAuthnAuthenticateEventHandler`, with challenges stored in D1 and spent by the read that verifies them. Credentials are discoverable, so sign-in sends no address and there is no list of which accounts hold a passkey.

**PRF does not pass through `nuxt-auth-utils`' client.** Its server handlers would forward an `extensions` option, but `useWebAuthn()` returns only a boolean and drops the authenticator's extension results, and `@simplewebauthn/browser` 11 passes `extensions` to the browser as given, so a PRF input serialised by the server would arrive as a string instead of bytes. The layer therefore calls `@simplewebauthn/browser`'s `startRegistration` / `startAuthentication` itself (`passkey-ceremony.ts`), adds `prf.eval.first` as bytes in the browser, reads `getClientExtensionResults().prf`, and removes it from the response before posting. The PRF output never reaches the server.

- The PRF input is a fixed label (`PASSKEY_PRF_INPUT`), so one passkey returns the same 32 bytes on every sign-in. Each passkey has its own.
- `unavailable` means the authenticator was asked and returned nothing (older security keys, some password managers). The passkey still signs in; fall back to `unlock(password)`.
- Some authenticators enable PRF at registration but only evaluate it on use. For those, `register()` asks the new passkey for one more assertion, locally, over a challenge made in the browser and sent nowhere. That is a second prompt, and it is the one place the browser API is used outside a server ceremony.
- A passkey is bound to the hostname. Moving the app to another domain orphans every passkey; passwords and reset keep working.

## Server hooks

```ts
// a Nitro plugin in the fork
onCredentialsPasswordReset({
  key: 'keys',
  statements: (db, { userId }) => [db.delete(keyWraps).where(/* this user's password wrap */)],
  after: async (db, { userId, at }) => {},
})
onCredentialsPasswordChange({ key: 'keys', /* same shape */ })
```

`statements` run in the same D1 batch as the new password and the session watermark: all of it lands or none does. `after` runs once that batch has committed; a throw there is logged (`credentials_password_hook_failed`) and does not undo the reset. A reset proves the mailbox and not the old password, so whatever was encrypted under the old unlock key cannot be opened again: that is what the reset hook is for. Both replacements set `users.sessions_invalid_before`, ending every other session; the one issued in the same request survives.

## Rules the routes keep

- **Nothing says whether an address has an account.** The params lookup answers an unknown address with a salt computed from the address and the instance secret (`getIdentitySalt()`), stable across calls. Sign-up and reset answer `{ ok: true }` either way. Sign-in has one failure, and verifies against a decoy hash when there is no account, so both cases cost one scrypt check.
- **One residual.** The decoy carries the current `iterations`. After that default is raised, an account still on the old count can be told apart until its password changes.
- **No account, and no password, before the mail comes back.** A pending sign-up is a token row holding only the address. A password or passkey is first written only in a request that carried a mailed token, which is what lets sign-in assert `emailVerified: true`; later ones are added from a session that began that way.
- **Tokens** ride in the URL fragment, are stored hashed, and are spent by one atomic `UPDATE`. A GET never spends one: both pages confirm with a button.
- **Every route is rate limited** (`CREDENTIALS_LIMITS`), on top of the per-IP limit core applies to `/api/auth/`. Sign-in also has a per-mailbox budget of 10 per 15 minutes, charged for every address. Mail is capped at 5 per mailbox per 15 minutes, counted in D1.
- **Turnstile** guards sign-up, sign-in and the reset request, and runs before any per-mailbox budget is charged. Passkey sign-in has none: nothing there can be guessed and nothing is mailed.
- **Password change needs the current password**. Passkeys, and a first password for an account that has none, are added only from a session.
- Signed-in routes live under `/api/credentials/`, not `/api/auth/`: the session guard lets a revoked cookie through on the latter.

## Tests

`layers/credentials/test/` runs in workerd against real D1: the derivation against fixed vectors, proof verification, the lookup, tokens and budgets, reset and change against core's `checkSession()`, and passkeys with a software authenticator that `@simplewebauthn/server` verifies for real, with PRF present, absent and enabled-only. `layers/credentials/test/e2e/` drives the pages in Chromium with its virtual authenticator.
