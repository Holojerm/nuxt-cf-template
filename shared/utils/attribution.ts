// First-touch attribution — how the person who became a customer first arrived.
//
// Lives in `shared/` because both halves need the same shape: the client plugin
// (app/plugins/attribution.client.ts) writes the cookie on first landing, and
// establishSession() reads it back when the account is created.
//
// ── Why first-touch, and why a cookie ────────────────────────────────────────
// The channel that *introduced* someone is the one worth spending on. Last-touch
// overwrites destroy that signal the moment a visitor returns via a branded
// search — which nearly all of them do, because signing up usually happens on a
// later visit than discovery. So the cookie is written once and never updated.
//
// A cookie rather than sessionStorage because the OAuth round-trip leaves this
// origin entirely, and because the server has to read it without running JS.
//
// ── The cookie is untrusted input ────────────────────────────────────────────
// Anyone can set it to anything. It is never an authorization input, and the
// server parses it through `attributionSchema` (strict, length-capped) before a
// single character reaches the database. Treat it exactly like a query string.

import { z } from 'zod'

/** Cookie name. Short — it rides on every request to this origin. */
export const ATTRIBUTION_COOKIE = 'attr'

/** How long a first touch stays credited. 90 days is the usual analytics window. */
export const ATTRIBUTION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

const SHORT_MAX = 100
const REFERRER_MAX = 500

/**
 * Validated attribution. Every field optional: a direct visit with no UTM
 * parameters is still a first touch worth recording, it just says 'direct'.
 *
 * `.catch(undefined)` on each field rather than rejecting the whole object —
 * a malformed cookie should degrade to "we don't know", never throw on a code
 * path that is trying to create somebody's account.
 */
export const attributionSchema = z.object({
  source: z.string().max(SHORT_MAX).optional().catch(undefined),
  medium: z.string().max(SHORT_MAX).optional().catch(undefined),
  campaign: z.string().max(SHORT_MAX).optional().catch(undefined),
  referrer: z.string().max(REFERRER_MAX).optional().catch(undefined),
})

export type Attribution = z.infer<typeof attributionSchema>

/**
 * Hosts we classify as organic search rather than plain referrals, so paid and
 * organic don't end up in the same bucket as "some website sent them".
 * Deliberately short — extend it for the engines your audience actually uses.
 */
const SEARCH_HOSTS = [
  'google.',
  'bing.com',
  'duckduckgo.com',
  'search.brave.com',
  'ecosia.org',
  'yandex.',
  'baidu.com',
  'startpage.com',
]

/** Answer engines. Worth separating: they are a distinct and growing channel. */
const AI_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'perplexity.ai',
  'claude.ai',
  'copilot.microsoft.com',
]

/** Strip `www.` so `www.example.com` and `example.com` are one source. */
function bareHost(host: string): string {
  return host.replace(/^www\./, '').toLowerCase()
}

function classifyReferrer(host: string): { source: string; medium: string } {
  const bare = bareHost(host)
  if (SEARCH_HOSTS.some((h) => bare.includes(h))) return { source: bare, medium: 'organic' }
  if (AI_HOSTS.some((h) => bare === h || bare.endsWith(`.${h}`))) {
    return { source: bare, medium: 'ai' }
  }
  return { source: bare, medium: 'referral' }
}

/** Trim, collapse to undefined when empty, and cap length. */
function clean(value: string | null | undefined, max = SHORT_MAX): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

export interface ParseAttributionInput {
  /** The full landing URL, including query string. */
  url: string
  /** `document.referrer` — empty string when there isn't one. */
  referrer?: string | null
  /** This site's own origin, so self-referrals aren't counted as a channel. */
  origin?: string | null
}

/**
 * Work out the first touch from a landing URL and referrer.
 *
 * Precedence: explicit UTM parameters beat an inferred referrer, because if
 * someone took the trouble to tag the link, the tag is the truth. `gclid` /
 * `fbclid` are recognised as paid clicks even with no utm_source, since ad
 * platforms often auto-tag with only those.
 *
 * Pure, and exported for test/attribution.test.ts.
 */
export function parseAttribution({ url, referrer, origin }: ParseAttributionInput): Attribution {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    params = new URLSearchParams()
  }

  const utmSource = clean(params.get('utm_source'))
  const utmMedium = clean(params.get('utm_medium'))
  const campaign = clean(params.get('utm_campaign'))

  // A referrer on our own origin means an internal navigation, not an arrival.
  let referrerHost: string | undefined
  let referrerUrl: string | undefined
  if (referrer) {
    try {
      const parsed = new URL(referrer)
      const selfHost = origin ? new URL(origin).host : undefined
      if (!selfHost || parsed.host !== selfHost) {
        referrerHost = parsed.host
        referrerUrl = clean(referrer, REFERRER_MAX)
      }
    } catch {
      // Unparseable referrer — ignore it rather than storing junk.
    }
  }

  if (utmSource) {
    return { source: utmSource, medium: utmMedium ?? 'unknown', campaign, referrer: referrerUrl }
  }

  // Ad-platform click ids, which frequently arrive untagged otherwise.
  const paidClick = params.get('gclid')
    ? 'google'
    : params.get('fbclid')
      ? 'facebook'
      : params.get('msclkid')
        ? 'bing'
        : undefined
  if (paidClick) {
    return { source: paidClick, medium: 'paid', campaign, referrer: referrerUrl }
  }

  if (referrerHost) {
    const { source, medium } = classifyReferrer(referrerHost)
    return { source, medium, campaign, referrer: referrerUrl }
  }

  return { source: 'direct', medium: 'none', campaign, referrer: undefined }
}

/**
 * Parse whatever was in the cookie into something safe to store.
 * Returns null when the cookie is absent, unparseable, or carries nothing.
 */
export function readAttributionCookie(raw: string | undefined): Attribution | null {
  if (!raw) return null
  let candidate: unknown
  try {
    candidate = JSON.parse(decodeURIComponent(raw))
  } catch {
    return null
  }
  const parsed = attributionSchema.safeParse(candidate)
  if (!parsed.success) return null
  const { source, medium, campaign, referrer } = parsed.data
  if (!source && !medium && !campaign && !referrer) return null
  return parsed.data
}
