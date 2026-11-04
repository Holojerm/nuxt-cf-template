// Cloudflare Turnstile verification for the public, unauthenticated surfaces.
//
// Rate limiters answer "how fast", never "is this a person"; a slow or widely
// distributed script satisfies both backends in rate-limit.ts. Turnstile is a
// browser challenge verified server-side with a secret only this Worker holds.
//
// Wired on POST /api/feedback (anonymous submissions only: signed-in users
// cleared OAuth, and gating them breaks programmatic useFeedback().submit()) and
// POST /api/auth/magic-link, the strongest reason this file exists, since it
// mails any address a script names. A new call site adds `turnstileToken` to its
// Zod schema, calls `await requireTurnstile(event, body.turnstileToken)`, and
// renders `<NuxtTurnstile v-model="token" />` behind the same
// `useRuntimeConfig().public.turnstile.siteKey` check.
//
// No secret key = verification skipped (like an unset Resend key), so a fresh
// clone runs without a Turnstile account. A HALF-configured fork (site key set,
// secret missing) renders a widget nothing verifies, which is security theatre,
// so it logs a structured warning instead of passing silently.

import { z } from 'zod'
import type { H3Event } from 'h3'
import { pathForLog, logEvent } from './log'

/**
 * A solved-challenge token as it arrives in a body. Cloudflare documents up to
 * 2048 characters; without a max an unconfigured fork would accept an arbitrary
 * string into a field it never reads, and a configured one would forward it.
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

/** A decision, plus the one outcome a decision cannot express: the check itself broke. */
export type TurnstileOutcome =
  | TurnstileDecision
  | { ok: false; code: 'turnstile_unavailable'; errorCodes: string[] }

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
 * The whole decision, with the network call injected so it is testable. The
 * secret-key check comes first, so an unconfigured deployment never rejects a
 * missing token it never asked the browser to produce.
 *
 * A verifier that throws is NOT a failed challenge, and the throw propagates
 * (to `resolveTurnstile`): unlike the advisory rate limiters, a bot check that
 * fails open on a network blip hands an attacker a bypass they cause on demand
 * by slowing siteverify. A Cloudflare outage takes the form down, visibly.
 */
export async function decideTurnstile(input: TurnstileInput): Promise<TurnstileDecision> {
  if (!input.secretKey) {
    if (input.siteKey) {
      logEvent('warn', 'turnstile_half_configured', {
        message:
          'NUXT_PUBLIC_TURNSTILE_SITE_KEY is set but NUXT_TURNSTILE_SECRET_KEY is not — ' +
          'the widget renders and nothing verifies the answer.',
      })
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
 * decideTurnstile, with a broken verifier turned into a refusal. Still
 * fail-CLOSED, but in the documented shape: the throw used to escape
 * `requireTurnstile` as a bare 500 with no `data.code`, so the form could not
 * tell the user a retry was worthwhile and each siteverify hiccup became an
 * $exception storm. A pure, injectable function so "a broken verifier does not
 * fail open" is a tested property (`requireTurnstile` needs `useRuntimeConfig`).
 */
export async function resolveTurnstile(input: TurnstileInput): Promise<TurnstileOutcome> {
  try {
    return await decideTurnstile(input)
  } catch (error) {
    logEvent('error', 'turnstile_unavailable', {
      // pathForLog, not event.path (see server/utils/log.ts).
      path: input.event ? pathForLog(input.event.path) : undefined,
      error: String(error),
    })
    return { ok: false, code: 'turnstile_unavailable', errorCodes: ['verifier-threw'] }
  }
}

/**
 * The real verifier: @nuxtjs/turnstile's POST to Cloudflare's siteverify.
 *
 * Imported dynamically, inside the call: that helper imports `#internal/nitro`,
 * which resolves only in a Nitro build, so a static import would make this file
 * unloadable in the workerd vitest pool (test/turnstile.test.ts would test
 * nothing), and deferring keeps an unconfigured fork from loading it. Explicit
 * rather than the module's auto-import, which can typecheck yet not be injected
 * at runtime (gotchas.md); that bug once disabled a rate limit, this guards a
 * bot check.
 */
const moduleVerifier: TurnstileVerifier = async (token, event) => {
  // The `.js` is required: the package's export map target has no extension and
  // TypeScript does not append one, failing `bun typecheck` with TS2307.
  const { verifyTurnstileToken } = await import('@nuxtjs/turnstile/runtime/server/utils/verify.js')
  return verifyTurnstileToken(token, event)
}

/**
 * H3 wrapper: require a solved challenge, or throw 400. No-ops when
 * `NUXT_TURNSTILE_SECRET_KEY` is unset. The `code` in `data` lets a client tell
 * "solve it again" from a form validation error (tokens expire after five
 * minutes, so a slow fill legitimately produces this).
 */
export async function requireTurnstile(event: H3Event, token: unknown): Promise<void> {
  const config = useRuntimeConfig(event)

  const decision = await resolveTurnstile({
    secretKey: config.turnstile.secretKey,
    siteKey: config.public.turnstile.siteKey,
    token,
    event,
    verify: moduleVerifier,
  })

  if (decision.ok) return

  logEvent('warn', 'turnstile_rejected', {
    // pathForLog, not event.path: this guards /api/auth/magic-link, next to routes with live tokens (see server/utils/log.ts).
    path: pathForLog(event.path),
    code: decision.code,
    errorCodes: decision.errorCodes,
  })

  throw createError({
    statusCode: 400,
    message:
      decision.code === 'turnstile_unavailable'
        ? 'Could not check that you are human right now. Please try again.'
        : 'Could not verify you are human. Please try again.',
    // Three codes, three sentences on the client (app/utils/auth-errors.ts): "solve it again" and "our check is down" are different instructions.
    data: { code: decision.code },
  })
}
