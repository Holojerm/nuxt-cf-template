// Per-service length rules. A post over the limit is rejected by the network
// after Buffer has accepted it, which surfaces as a Buffer error email rather
// than anything the app sees, so the outbox refuses it before sending.

export const SOCIAL_SERVICES = ['x', 'bluesky'] as const
export type SocialService = (typeof SOCIAL_SERVICES)[number]

export const SOCIAL_LIMITS: Record<SocialService, number> = {
  x: 280,
  bluesky: 300,
}

const URL_RE = /https?:\/\/\S+/g

/** X shortens every link to t.co, so a URL weighs 23 whatever its length. */
const X_URL_WEIGHT = 23

/**
 * twitter-text v3 weighting: these code point ranges count 1, everything else
 * (CJK, most emoji) counts 2. Per code point, so a ZWJ emoji sequence
 * over-counts slightly — the safe direction.
 */
const X_LIGHT_RANGES: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
]

function xLength(text: string): number {
  let length = 0
  const rest = text.replace(URL_RE, () => {
    length += X_URL_WEIGHT
    return ''
  })
  for (const char of rest) {
    const cp = char.codePointAt(0) ?? 0
    length += X_LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2
  }
  return length
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

function graphemeLength(text: string): number {
  let length = 0
  for (const _ of graphemes.segment(text)) length++
  return length
}

/** Length as the service counts it against SOCIAL_LIMITS. */
export function socialLength(service: SocialService, text: string): number {
  return service === 'x' ? xLength(text) : graphemeLength(text)
}

export function fitsSocial(service: SocialService, text: string): boolean {
  return socialLength(service, text) <= SOCIAL_LIMITS[service]
}

/**
 * `head` then `tail` on one line, with `head` cut at a word boundary (and an
 * ellipsis) until the whole fits. `tail` — usually the link — is never cut.
 */
export function fitSocialText(service: SocialService, head: string, tail = ''): string {
  const join = (h: string) => [h, tail].filter(Boolean).join(' ')
  const full = join(head.trim())
  if (fitsSocial(service, full)) return full

  const words = head.trim().split(/\s+/)
  while (words.length > 1) {
    words.pop()
    const candidate = join(`${words.join(' ').replace(/[\s,;:.–—-]+$/, '')}…`)
    if (fitsSocial(service, candidate)) return candidate
  }
  // One word longer than the budget: cut by characters.
  let word = words[0] ?? ''
  while (word && !fitsSocial(service, join(`${word}…`))) word = word.slice(0, -1)
  return join(word ? `${word}…` : '')
}
