// Cloudflare Turnstile verification for the public, unauthenticated surfaces.
//
// ── What this is for ─────────────────────────────────────────────────────────
// The rate limiters in this repo answer "how fast", never "is this a person".
// Against a script that spends its budget slowly, or one distributed across
// enough addresses that no single bucket fills, both backends in
// server/utils/rate-limit.ts are content. Turnstile is the other half of that:
// a challenge the browser solves, verified server-side against a secret only
// this Worker holds.
//
// ── Where it is wired ────────────────────────────────────────────────────────
//   * POST /api/feedback — anonymous submissions only. A signed-in submitter
//     already cleared OAuth, and gating them would break the programmatic
//     prompts that call useFeedback().submit() with no widget on screen.
//
// SEAM FOR THE MAGIC-LINK PASS: the second call site is the magic-link *request*
// endpoint (the handler that accepts an email address and mails a sign-in link).
// That endpoint is the strongest reason this file exists — it will send mail to
// any address a script names, which makes it a spam cannon pointed at strangers,
// and a rate limit only decides how fast the cannon fires. Wiring it is two
// lines: add `turnstileToken` to the request's Zod schema, then
// `await requireTurnstile(event, body.turnstileToken)` before the send. On the
// client, render `<NuxtTurnstile v-model="token" />` behind the same
// `useRuntimeConfig().public.turnstile.siteKey` check the feedback widget uses.
//
// ── Unconfigured behaviour ───────────────────────────────────────────────────
// No secret key = verification is skipped, exactly like an unset Resend key
// makes email a logged no-op. That is what lets a fresh clone run without a
// Turnstile account. The one case worth shouting about is a HALF-configured
// fork — site key set, secret key missing — because then the widget renders,
// the user solves a challenge, and nothing checks the answer. That is security
// theatre, so it gets a structured warning rather than a silent pass.

import { z } from 'zod'
import type { H3Event } from 'h3'
import { pathForLog } from './log'

/**
 * A solved-challenge token, as it arrives in a request body.
 *
 * Cloudflare documents the token as up to 2048 characters. Bounding it here
 * matters more than it looks: without a max, an unconfigured fork would accept
 * an arbitrarily large string into a field it never reads, and a configured one
 * would forward it to siteverify.
 */
export const turnstileTokenSchema = z.string().min(1).max(2048)

/** The subset of Cloudflare's siteverify response this module acts on. */
export interface TurnstileVerification {
  success: boolean
  'error-codes'?: string[]
}

/** `verifyTurnstileToken` from @nuxtjs/turnstile, or a fake in tests. */
export type TurnstileVerifier = (token: string, event?: H3Event) => Promise<TurnstileVerification>

export type TurnstileDecision =
  /** No secret key: nothing was checked, and that is the configured behaviour. */
  | { ok: true; checked: false }
  | { ok: true; checked: true }
  | { ok: false; code: 'turnstile_missing' | 'turnstile_failed'; errorCodes: string[] }

export interface TurnstileInput {
  /** `runtimeConfig.turnstile.secretKey`. Empty or unset disables the check. */
  secretKey: string | undefined
  /** `runtimeConfig.public.turnstile.siteKey`, only to detect half-configuration. */
  siteKey?: string | undefined
  /** Whatever the client sent. Unvalidated on purpose — this narrows it. */
  token: unknown
  verify: TurnstileVerifier
  event?: H3Event
}

/**
 * The whole decision, with the network call injected so it is testable.
 *
 * Ordering is deliberate: the secret-key check comes first, so an unconfigured
 * deployment never rejects a request for a missing token it never asked the
 * browser to produce.
 *
 * A verifier that throws is NOT treated like a failed challenge. The rate
 * limiters in this repo fail open because they are advisory; a bot check is
 * the opposite — failing open on a network blip would hand an attacker a
 * bypass they can cause on demand by making siteverify slow. So the throw
 * propagates and the caller turns it into a 400, and the honest trade is that
 * a Cloudflare outage takes this form down with it.
 */
export async function decideTurnstile(input: TurnstileInput): Promise<TurnstileDecision> {
  if (!input.secretKey) {
    if (input.siteKey) {
      console.warn(
        JSON.stringify({
          kind: 'turnstile_half_configured',
          message:
            'NUXT_PUBLIC_TURNSTILE_SITE_KEY is set but NUXT_TURNSTILE_SECRET_KEY is not — ' +
            'the widget renders and nothing verifies the answer.',
        }),
      )
    }
    return { ok: true, checked: false }
  }

  const parsed = turnstileTokenSchema.safeParse(input.token)
  if (!parsed.success) {
    return { ok: false, code: 'turnstile_missing', errorCodes: ['missing-input-response'] }
  }

  const result = await input.verify(parsed.data, input.event)
  if (result.success) return { ok: true, checked: true }

  return { ok: false, code: 'turnstile_failed', errorCodes: result['error-codes'] ?? [] }
}

/**
 * The real verifier: @nuxtjs/turnstile's POST to
 * https://challenges.cloudflare.com/turnstile/v0/siteverify.
 *
 * Imported dynamically, and inside the call rather than beside it, for two
 * reasons. First, that helper imports `#internal/nitro`, an alias that resolves
 * only inside a Nitro build — a static import would make this file unloadable
 * in the workerd vitest pool, and test/turnstile.test.ts would be testing
 * nothing. Second, deferring it to the moment of use means an unconfigured fork
 * never pulls the module in at all.
 *
 * Explicit rather than the Nitro auto-import the module also registers:
 * CLAUDE.md › Gotchas has the story of an auto-import that typechecked
 * everywhere and was not injected at runtime, and that one only disabled a rate
 * limit. This guards a bot check.
 */
const moduleVerifier: TurnstileVerifier = async (token, event) => {
  // The `.js` is required, not stylistic. @nuxtjs/turnstile's export map is
  // `"./runtime/*": "./dist/runtime/*"`, a literal target with no extension —
  // TypeScript does not append one to an exports substitution, so dropping it
  // resolves the value at runtime and fails `bun typecheck` with TS2307.
  const { verifyTurnstileToken } = await import('@nuxtjs/turnstile/runtime/server/utils/verify.js')
  return verifyTurnstileToken(token, event)
}

/**
 * H3 wrapper: require a solved challenge, or throw 400.
 *
 *   await requireTurnstile(event, body.turnstileToken)
 *
 * No-ops when `NUXT_TURNSTILE_SECRET_KEY` is unset. The 400 carries a `code` in
 * `data` so a client can tell "solve the challenge again" apart from a
 * validation error on the rest of the form — the token expires after five
 * minutes, so a slow form fill produces this legitimately.
 */
export async function requireTurnstile(event: H3Event, token: unknown): Promise<void> {
  const config = useRuntimeConfig(event)

  const decision = await decideTurnstile({
    secretKey: config.turnstile.secretKey,
    siteKey: config.public.turnstile.siteKey,
    token,
    event,
    verify: moduleVerifier,
  })

  if (decision.ok) return

  console.warn(
    JSON.stringify({
      kind: 'turnstile_rejected',
      // Same rule as everywhere else that logs a path — see server/utils/log.ts.
      // This one now guards /api/auth/magic-link, and a route next to it carries
      // a live token; the habit is cheaper to keep than to remember.
      path: pathForLog(event.path),
      code: decision.code,
      errorCodes: decision.errorCodes,
    }),
  )

  throw createError({
    statusCode: 400,
    message: 'Could not verify you are human. Please try again.',
    data: { code: decision.code },
  })
}
